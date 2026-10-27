// Background Service Worker for mast (Meeting AI Summarizer & Transcriber for MS Teams)

const WORKER_BUILD_VERSION = '2.7.6';
let isGeneratingInMemory = false;

const TEAMS_URL_PATTERNS = [
  "https://teams.microsoft.com/*",
  "https://*.teams.microsoft.com/*",
  "https://teams.live.com/*",
  "https://*.teams.live.com/*",
  "https://teams.cloud.microsoft/*",
  "https://*.teams.cloud.microsoft/*"
];

async function injectContentScriptIntoOpenTeamsTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: TEAMS_URL_PATTERNS });
    for (const tab of tabs) {
      if (tab.id) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['content.js']
        }, () => {
          void chrome.runtime.lastError;
        });
      }
    }
  } catch (_) {}
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error('Request timed out. Please click Retry.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function getTopStableFlashModels(models) {
  const validModels = (models || []).filter(
    m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent")
  );

  const familyMap = new Map();
  for (const m of validModels) {
    const match = m.name.match(/^models\/gemini-(\d+)(?:\.(\d+))?-flash(?:-(\d{3}))?$/i);
    if (!match) continue;

    const major = parseInt(match[1], 10);
    const minor = match[2] !== undefined ? parseInt(match[2], 10) : 0;
    const rev = match[3] !== undefined ? parseInt(match[3], 10) : null;
    const familyKey = `${major}.${minor}`;

    const existing = familyMap.get(familyKey);
    if (!existing) {
      familyMap.set(familyKey, { model: m, major, minor, rev });
    } else if (rev === null && existing.rev !== null) {
      familyMap.set(familyKey, { model: m, major, minor, rev });
    } else if (rev !== null && existing.rev !== null && rev > existing.rev) {
      familyMap.set(familyKey, { model: m, major, minor, rev });
    }
  }

  const sorted = Array.from(familyMap.values()).sort((a, b) => {
    if (b.major !== a.major) return b.major - a.major;
    return b.minor - a.minor;
  });

  return sorted.slice(0, 2).map(entry => entry.model);
}

function getDefaultFlashModelId(topFlashModels) {
  if (!topFlashModels || topFlashModels.length === 0) return 'gemini-2.5-flash';
  const preferred = topFlashModels.length >= 2 ? topFlashModels[1] : topFlashModels[0];
  return preferred.name.replace('models/', '');
}

async function resolveActiveModel(apiKey, storedState) {
  if (storedState.modelSelectVal === 'custom' && storedState.customModelVal) {
    return storedState.customModelVal.trim().replace(/^models\//, '');
  }

  try {
    const response = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      {},
      8000
    );
    if (response.ok) {
      const data = await response.json();
      const topFlash = getTopStableFlashModels(data.models);
      const validIds = topFlash.map(m => m.name.replace('models/', ''));

      if (validIds.length > 0) {
        if (
          storedState.userSelectedModel &&
          storedState.selectedModel &&
          validIds.includes(storedState.selectedModel)
        ) {
          return storedState.selectedModel;
        }
        const defaultFlashId = getDefaultFlashModelId(topFlash);
        await chrome.storage.local.set({
          selectedModel: defaultFlashId,
          modelSelectVal: defaultFlashId
        });
        return defaultFlashId;
      }
    }
  } catch (e) {
    console.warn("mast: Could not fetch model list, falling back to stored or default Flash model.", e);
  }

  if (storedState.selectedModel && /^gemini-(\d+)(?:\.(\d+))?-flash(?:-(\d{3}))?$/i.test(storedState.selectedModel)) {
    return storedState.selectedModel;
  }
  return 'gemini-2.5-flash';
}

function formatShortDate(dateObj = new Date()) {
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const mon = months[dateObj.getMonth()];
  const day = dateObj.getDate();
  const year = dateObj.getFullYear();
  return `${mon}${day}-${year}`;
}

function sanitizeFilenameTitle(rawTitle, fallback = 'meeting') {
  if (!rawTitle || typeof rawTitle !== 'string') return fallback;
  const sanitized = rawTitle
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 60);
  if (!sanitized || sanitized === 'title') return fallback;
  return sanitized;
}

function downloadTextViaDataUrl(content, mimeType, filename) {
  const dataUrl = `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url: dataUrl, filename: filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(downloadId);
      }
    });
  });
}

async function saveToRecentMeetings(lines, meetingTitle, startTime) {
  if (!lines || lines.length === 0) return null;
  const stored = await chrome.storage.local.get(['recentMeetings', 'startTime']);
  const recent = Array.isArray(stored.recentMeetings) ? stored.recentMeetings : [];

  const sessionTimestamp = startTime || stored.startTime || Date.now();
  const sessionId = String(sessionTimestamp);
  const dateObj = new Date(sessionTimestamp);
  const shortDate = formatShortDate(dateObj);
  const displayDate = dateObj.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
  const cleanTitle =
    meetingTitle && typeof meetingTitle === 'string' && meetingTitle.trim()
      ? meetingTitle.trim()
      : 'Meeting';

  const existingIdx = recent.findIndex((m) => m.id === sessionId);
  const existingEntry = existingIdx >= 0 ? recent[existingIdx] : null;

  const entry = {
    id: sessionId,
    title: existingEntry && cleanTitle === 'Meeting' ? existingEntry.title : cleanTitle,
    teamsTitle: cleanTitle !== 'Meeting' ? cleanTitle : (existingEntry?.teamsTitle || 'Meeting'),
    shortDate,
    displayDate,
    timestamp: sessionTimestamp,
    lines
  };

  if (existingIdx >= 0) {
    recent.splice(existingIdx, 1);
  }
  recent.unshift(entry);

  const trimmed = recent.slice(0, 5);
  await chrome.storage.local.set({
    recentMeetings: trimmed,
    startTime: sessionTimestamp
  });
  return entry;
}

async function updateRecentMeetingTitle(sessionId, newTitle) {
  if (!newTitle || newTitle === 'Meeting') return;
  const stored = await chrome.storage.local.get(['recentMeetings']);
  const recent = Array.isArray(stored.recentMeetings) ? stored.recentMeetings : [];
  if (recent.length === 0) return;

  let idx = sessionId ? recent.findIndex((m) => m.id === String(sessionId)) : 0;
  if (idx < 0) idx = 0;

  if (!recent[idx].title || recent[idx].title === 'Meeting' || recent[idx].title === 'meeting') {
    recent[idx].title = newTitle;
    await chrome.storage.local.set({ recentMeetings: recent });
  }
}

async function downloadTranscriptIfNeeded(forceDownload = false) {
  const result = await chrome.storage.local.get(['savedTranscript', 'transcriptDownloaded', 'meetingTitle', 'startTime']);
  const lines = result.savedTranscript || [];
  if (lines.length === 0) return false;

  await saveToRecentMeetings(lines, result.meetingTitle, result.startTime);

  if (!forceDownload && result.transcriptDownloaded) return false;

  const fullTranscript = lines.join('\n');
  const meetingName = sanitizeFilenameTitle(result.meetingTitle, 'meeting');
  const shortDate = formatShortDate();
  const filename = `transcript_${meetingName}_${shortDate}.txt`;

  await downloadTextViaDataUrl(fullTranscript, 'text/plain', filename);
  await chrome.storage.local.set({ transcriptDownloaded: true });
  return true;
}

async function generateAndDownloadNotes(overrideMeeting = null) {
  const isHistoryRegen = !!overrideMeeting;
  if (!isHistoryRegen && isGeneratingInMemory) {
    return { status: "already_generating" };
  }
  if (!isHistoryRegen) {
    isGeneratingInMemory = true;
  }

  // Keep MV3 service worker alive while waiting on network generation
  const keepAliveInterval = setInterval(() => {
    chrome.storage.local.get(['notesStatus'], () => {});
  }, 15000);

  try {
    const result = await chrome.storage.local.get([
      'savedTranscript',
      'apiKey',
      'selectedModel',
      'modelSelectVal',
      'customModelVal',
      'userSelectedModel',
      'meetingTitle',
      'titleSource',
      'startTime'
    ]);

    const lines = isHistoryRegen ? (overrideMeeting.lines || []) : (result.savedTranscript || []);
    if (lines.length === 0) {
      if (!isHistoryRegen) {
        await chrome.storage.local.set({
          notesStatus: 'error',
          notesError: 'No captions captured.'
        });
      }
      return { status: "error", error: "No captions captured." };
    }

    const apiKey = result.apiKey ? result.apiKey.trim() : '';
    if (!apiKey) {
      if (!isHistoryRegen) {
        await chrome.storage.local.set({
          notesStatus: 'error',
          notesError: 'API Key missing.'
        });
      }
      return { status: "error", error: "API Key missing." };
    }

    let savedEntry = null;
    if (!isHistoryRegen) {
      savedEntry = await saveToRecentMeetings(lines, result.meetingTitle, result.startTime);
      await chrome.storage.local.set({
        notesStatus: 'generating',
        notesError: '',
        generationStartedAt: Date.now()
      });
    }

    const model = await resolveActiveModel(apiKey, result);
    const fullTranscript = lines.join('\n');

    const dateObj = isHistoryRegen && overrideMeeting.timestamp ? new Date(overrideMeeting.timestamp) : new Date();
    const dateFormatted =
      dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) +
      ' at ' +
      dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) +
      ' UTC';

    const prompt = `## Role

You are an expert meeting minutes generator. Your task is to process provided information about a meeting, such as a transcript, recording summary, or rough human notes, and generate crisp, well-structured meeting notes following a specific format.

## Output Expectations

Your output must be a well-structured set of meeting minutes that perfectly adheres to the required format.

1.  **Strict Formatting:** You must output the meeting minutes using the exact section headings provided below. Do not modify the section names. Each bullet must be a distinct section.
2.  **Title:** You must generate a short, concise title for the meeting based on the transcript (less than 7 words). It must be placed at the very beginning of the document in this exact format:
# Title
[Your Generated Title Here]
3.  **Date, time, and attendees:** Extract and present the date, time, and attendees. The companies of the attendees must be mentioned. This section must consist of exactly two bullet points following this format:
    *   [Date], at [Time] The time is the time showing in the transcript.
    *   Attendees: [Name] ([Company]), [Name] ([Company]). Company may not be obvious, identify from transcript. If it is not clearly identifiable, do not mention company name. Leave it blank.
4.  **Meeting purpose:** Clearly state the goal of the meeting to provide context.
5.  **Agenda items:** Break the minutes into sections that match the meeting's agenda to ensure scannability.
6.  **Key discussions:** Capture the key points discussed concisely. Do not capture every word. (e.g., "Team discussed marketing budget concerns. Decision deferred until Q2.")
7.  **Decisions made:** Clearly state any decisions that were made. You must **bold these decisions** so they are easy to spot.
8.  **Action items:** Identify who is responsible for what action and by when. Write these items clearly. (e.g., "John – finalize vendor contract by March 15.")
9.  **Follow-ups:** Note any unresolved issues or topics that were deferred to future meetings.

Note: The meeting took place on ${dateFormatted}.

Transcript:
${fullTranscript}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 }
    };

    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      },
      60000
    );

    if (!response.ok) {
      let errMsg = "Google AI Studio Error";
      try {
        const errorData = await response.json();
        if (errorData.error?.message) errMsg = errorData.error.message;
      } catch (_) {}
      throw new Error(errMsg);
    }

    const data = await response.json();
    const minutesText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!minutesText) {
      throw new Error("Empty response from Gemini model.");
    }

    let aiTitle = "meeting";
    const outLines = minutesText.split('\n');
    for (let i = 0; i < outLines.length; i++) {
      if (outLines[i].toLowerCase().includes('# title') && i + 1 < outLines.length) {
        aiTitle = outLines[i + 1].trim();
        if (!aiTitle && i + 2 < outLines.length) {
          aiTitle = outLines[i + 2].trim();
        }
        break;
      }
    }

    const useTeamsTitle = result.titleSource === 'teams';
    const rawTeamsTitle = isHistoryRegen
      ? (overrideMeeting.teamsTitle || overrideMeeting.title)
      : result.meetingTitle;
    const hasTeamsTitle =
      rawTeamsTitle &&
      typeof rawTeamsTitle === 'string' &&
      rawTeamsTitle.trim() &&
      rawTeamsTitle.trim().toLowerCase() !== 'meeting';

    const chosenTitle = useTeamsTitle && hasTeamsTitle ? rawTeamsTitle.trim() : aiTitle;
    const sanitizedTitle = sanitizeFilenameTitle(chosenTitle, 'meeting');
    const shortDate = isHistoryRegen && overrideMeeting.shortDate ? overrideMeeting.shortDate : formatShortDate(dateObj);
    const filename = `${sanitizedTitle}_${shortDate}.md`;

    await downloadTextViaDataUrl(minutesText, 'text/markdown', filename);

    if (isHistoryRegen) {
      await updateRecentMeetingTitle(overrideMeeting.id, chosenTitle);
    } else {
      await updateRecentMeetingTitle(savedEntry ? savedEntry.id : result.startTime, chosenTitle);
      await chrome.storage.local.set({
        notesStatus: 'done',
        notesError: ''
      });
    }

    return { status: "done", filename };
  } catch (error) {
    console.error("mast: Generation failed:", error);
    if (!isHistoryRegen) {
      await chrome.storage.local.set({
        notesStatus: 'error',
        notesError: error.message || "Failed to generate AI summary."
      });
    }
    return { status: "error", error: error.message };
  } finally {
    clearInterval(keepAliveInterval);
    if (!isHistoryRegen) {
      isGeneratingInMemory = false;
    }
  }
}

async function regenerateMeetingFromHistory(meetingId) {
  const stored = await chrome.storage.local.get(['recentMeetings']);
  const recent = Array.isArray(stored.recentMeetings) ? stored.recentMeetings : [];
  const target = recent.find((m) => m.id === String(meetingId));
  if (!target || !target.lines || target.lines.length === 0) {
    return { status: "error", error: "Meeting transcript not found in storage." };
  }
  return await generateAndDownloadNotes(target);
}

async function handleSessionEnded() {
  const result = await chrome.storage.local.get(['savedTranscript', 'isTranscribing', 'notesStatus']);
  if (result.isTranscribing) {
    await chrome.storage.local.set({ isTranscribing: false });
  }

  const lines = result.savedTranscript || [];
  if (lines.length === 0) {
    await chrome.storage.local.set({ notesStatus: 'idle' });
    return { status: "no_transcript" };
  }

  try {
    await downloadTranscriptIfNeeded(false);
  } catch (e) {
    console.error("mast: Failed to auto-download transcript:", e);
  }

  if (result.notesStatus === 'done' || isGeneratingInMemory) {
    return { status: result.notesStatus || "generating" };
  }

  return await generateAndDownloadNotes();
}

async function stopTabAndFinalize(tabId) {
  const stored = await chrome.storage.local.get(['activeTabId']);
  const targetTabId = tabId || stored.activeTabId;
  if (targetTabId) {
    try {
      await new Promise((resolve) => {
        chrome.tabs.sendMessage(targetTabId, { action: "stop" }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      });
      await new Promise((r) => setTimeout(r, 150));
    } catch (_) {}
  }
  return await handleSessionEnded();
}

async function startFromToast(sender, meetingTitle) {
  const stored = await chrome.storage.local.get(['apiKey']);
  if (!stored.apiKey || !stored.apiKey.trim()) {
    chrome.runtime.openOptionsPage();
    return { status: "no_api_key" };
  }

  const startTime = Date.now();
  const tabId = sender && sender.tab ? sender.tab.id : null;
  const initialTitle =
    meetingTitle && typeof meetingTitle === 'string' && meetingTitle.trim() && meetingTitle.trim() !== 'Meeting'
      ? meetingTitle.trim()
      : 'Meeting';

  await chrome.storage.local.set({
    savedTranscript: [],
    isTranscribing: true,
    startTime: startTime,
    issueDetected: false,
    activeTabId: tabId,
    notesStatus: 'idle',
    notesError: '',
    transcriptDownloaded: false,
    callEnded: false,
    meetingTitle: initialTitle
  });

  if (tabId) {
    chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      files: ['content.js']
    }, () => {
      void chrome.runtime.lastError;
      chrome.tabs.sendMessage(tabId, { action: "start" }, () => {
        void chrome.runtime.lastError;
      });
    });
  }

  return { status: "started", startTime };
}

async function recoverStuckGenerationIfNeeded() {
  if (isGeneratingInMemory) {
    return { status: "generating_in_memory" };
  }
  const result = await chrome.storage.local.get([
    'notesStatus',
    'savedTranscript',
    'isTranscribing',
    'generationStartedAt'
  ]);
  if (result.notesStatus !== 'generating') {
    return { status: result.notesStatus || "idle" };
  }

  const ageMs = result.generationStartedAt ? Date.now() - result.generationStartedAt : Infinity;
  if (ageMs < 2000) {
    return { status: "starting" };
  }

  const lines = result.savedTranscript || [];
  if (lines.length === 0) {
    await chrome.storage.local.set({
      isTranscribing: false,
      notesStatus: 'idle',
      notesError: ''
    });
    return { status: "idle" };
  }

  console.log("mast: Recovering interrupted AI notes generation...");
  return await handleSessionEnded();
}

async function backfillRecentMeetingsIfNeeded() {
  const result = await chrome.storage.local.get(['savedTranscript', 'meetingTitle', 'startTime']);
  if (result.savedTranscript && result.savedTranscript.length > 0) {
    await saveToRecentMeetings(result.savedTranscript, result.meetingTitle, result.startTime);
  }
}

// Auto-migrate model selection, inject content script, and recover any interrupted generation on install/reload
chrome.runtime.onInstalled.addListener(async () => {
  const result = await chrome.storage.local.get([
    'apiKey',
    'selectedModel',
    'modelSelectVal',
    'customModelVal',
    'userSelectedModel',
    'reopenOptionsAfterReload'
  ]);
  if (result.reopenOptionsAfterReload) {
    await chrome.storage.local.set({ reopenOptionsAfterReload: false });
    chrome.runtime.openOptionsPage();
  }
  if (result.apiKey) {
    await resolveActiveModel(result.apiKey, result);
  }
  await backfillRecentMeetingsIfNeeded();
  await injectContentScriptIntoOpenTeamsTabs();
  await recoverStuckGenerationIfNeeded();
});

chrome.runtime.onStartup.addListener(async () => {
  await backfillRecentMeetingsIfNeeded();
  await injectContentScriptIntoOpenTeamsTabs();
  await recoverStuckGenerationIfNeeded();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab && tab.url) {
    const url = tab.url.toLowerCase();
    if (
      url.includes('teams.microsoft.com') ||
      url.includes('teams.live.com') ||
      url.includes('teams.cloud.microsoft')
    ) {
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['content.js']
      }, () => {
        void chrome.runtime.lastError;
      });
    }
  }
});

// Safety net: if the user closes the Teams tab, finalize any active session & clean up state
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const result = await chrome.storage.local.get(['isTranscribing', 'activeTabId', 'savedTranscript', 'notesStatus']);
  if (result.activeTabId === tabId) {
    if (result.isTranscribing || (result.notesStatus === 'generating' && !isGeneratingInMemory)) {
      await chrome.storage.local.set({ isTranscribing: false, callEnded: true });
      if (result.savedTranscript && result.savedTranscript.length > 0) {
        await handleSessionEnded();
      }
    }
    const afterState = await chrome.storage.local.get(['notesStatus']);
    if (!isGeneratingInMemory && afterState.notesStatus !== 'error') {
      await chrome.storage.local.set({
        savedTranscript: [],
        activeTabId: null,
        notesStatus: 'idle',
        notesError: '',
        transcriptDownloaded: false,
        meetingTitle: 'Meeting'
      });
    }
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "get_worker_version") {
    sendResponse({ version: WORKER_BUILD_VERSION });
    return false;
  } else if (request.action === "start_from_toast") {
    startFromToast(sender, request.meetingTitle).then(sendResponse);
    return true;
  } else if (request.action === "open_options") {
    chrome.runtime.openOptionsPage();
    sendResponse({ status: "opened" });
    return false;
  } else if (request.action === "session_ended") {
    handleSessionEnded().then(sendResponse);
    return true;
  } else if (request.action === "stop_and_finalize") {
    stopTabAndFinalize(request.tabId).then(sendResponse);
    return true;
  } else if (request.action === "check_generation_status") {
    recoverStuckGenerationIfNeeded().then(sendResponse);
    return true;
  } else if (request.action === "generate_notes") {
    generateAndDownloadNotes().then(sendResponse);
    return true;
  } else if (request.action === "regenerate_meeting_notes") {
    regenerateMeetingFromHistory(request.meetingId).then(sendResponse);
    return true;
  } else if (request.action === "download_transcript") {
    downloadTranscriptIfNeeded(true)
      .then(() => sendResponse({ status: "downloaded" }))
      .catch((err) => sendResponse({ status: "error", error: err.message }));
    return true;
  }
});
