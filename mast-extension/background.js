// Background Service Worker for mast (Meeting AI Summarizer & Transcriber for MS Teams)

const WORKER_BUILD_VERSION = '2.9-dev-9';
let isGeneratingInMemory = false;
let cachedBaseIconBitmap = null;

async function getBaseIconBitmap() {
  if (cachedBaseIconBitmap) return cachedBaseIconBitmap;
  try {
    if (typeof fetch !== 'function' || typeof createImageBitmap !== 'function') return null;
    const res = await fetch(chrome.runtime.getURL('icons/icon48.png'));
    const blob = await res.blob();
    cachedBaseIconBitmap = await createImageBitmap(blob);
    return cachedBaseIconBitmap;
  } catch (_) {
    return null;
  }
}

function renderIconWithDot(bitmap, size, dotColor) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  if (bitmap) {
    ctx.drawImage(bitmap, 0, 0, size, size);
  }
  if (dotColor) {
    const r = Math.max(3.2, size * 0.215);
    const ring = Math.max(1.1, size * 0.065);
    const cx = size - r - ring * 0.5;
    const cy = size - r - ring * 0.5;

    ctx.beginPath();
    ctx.arc(cx, cy, r + ring, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20, 20, 24, 0.94)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.fill();
  }
  return ctx.getImageData(0, 0, size, size);
}

async function syncToolbarBadge() {
  try {
    if (typeof chrome === 'undefined' || !chrome.action) {
      return;
    }
    const stored = await chrome.storage.local.get([
      'isTranscribing',
      'liveCaptionsOn',
      'notesStatus',
      'inActiveCall'
    ]);

    let dotColor = null;

    if (stored.isTranscribing) {
      dotColor = stored.liveCaptionsOn === false ? '#FF9F0A' : '#30D158';
    } else if (stored.notesStatus === 'generating') {
      dotColor = '#8B8FF8';
    } else if (stored.notesStatus === 'error') {
      dotColor = '#FF453A';
    } else if (stored.inActiveCall) {
      dotColor = '#8B8FF8';
    }

    self.__mastToolbarDotColor = dotColor;

    if (typeof chrome.action.setBadgeText === 'function') {
      await chrome.action.setBadgeText({ text: '' });
    }

    if (typeof chrome.action.setIcon === 'function') {
      if (!dotColor) {
        await chrome.action.setIcon({
          path: {
            16: 'icons/icon16.png',
            48: 'icons/icon48.png',
            128: 'icons/icon128.png'
          }
        });
      } else if (typeof OffscreenCanvas !== 'undefined') {
        const bitmap = await getBaseIconBitmap();
        const imageData = {
          16: renderIconWithDot(bitmap, 16, dotColor),
          32: renderIconWithDot(bitmap, 32, dotColor),
          48: renderIconWithDot(bitmap, 48, dotColor)
        };
        await chrome.action.setIcon({ imageData });
      }
    }
  } catch (_) {}
}

const TEAMS_URL_PATTERNS = [
  "https://teams.microsoft.com/*",
  "https://*.teams.microsoft.com/*",
  "https://teams.live.com/*",
  "https://*.teams.live.com/*",
  "https://teams.cloud.microsoft/*",
  "https://*.teams.cloud.microsoft/*"
];

async function cleanupLegacyState() {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('cache', { recursive: true }).catch(() => {});
    }
  } catch (_) {}

  try {
    await chrome.storage.local.remove([
      'aiMode',
      'onboardingCompleted',
      'devNanoSimMode',
      'notesErrorCode',
      'notesErrorReason'
    ]);

    const stored = await chrome.storage.local.get(['selectedModel', 'modelSelectVal', 'titleSource', 'hideCaptionBox']);
    const updates = {};
    const flashPattern = /^gemini-(\d+)(?:\.(\d+))?-flash(?:-(\d{3}))?$/i;
    if (stored.modelSelectVal && stored.modelSelectVal !== 'custom' && !flashPattern.test(stored.modelSelectVal)) {
      updates.selectedModel = '';
      updates.modelSelectVal = '';
    } else if (stored.selectedModel && stored.modelSelectVal !== 'custom' && !flashPattern.test(stored.selectedModel)) {
      updates.selectedModel = '';
      updates.modelSelectVal = '';
    }
    if (stored.titleSource === undefined) {
      updates.titleSource = 'ai';
    }
    if (stored.hideCaptionBox === undefined) {
      updates.hideCaptionBox = true;
    }
    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
    }
  } catch (_) {}
}

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
    chrome.storage.local.get(['notesStatus'], () => {
      void chrome.runtime.lastError;
    });
  }, 15000);

  let cloudTickerInterval = null;

  const reportProgress = async (progress, stage) => {
    const clamped = Math.max(0, Math.min(100, Math.round(progress)));
    try {
      if (isHistoryRegen) {
        await chrome.storage.local.set({
          historyRegenProgress: {
            meetingId: String(overrideMeeting.id),
            progress: clamped,
            stage: stage || '',
            active: clamped < 100
          }
        });
      } else {
        await chrome.storage.local.set({
          notesProgress: clamped,
          notesStage: stage || ''
        });
      }
    } catch (_) {}
  };

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
        notesProgress: 5,
        notesStage: 'Connecting to Gemini...',
        generationStartedAt: Date.now()
      });
    } else {
      await reportProgress(5, 'Connecting to Gemini...');
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

    let cloudPct = 20;
    await reportProgress(cloudPct, 'Generating meeting notes...');
    cloudTickerInterval = setInterval(() => {
      if (cloudPct < 88) {
        cloudPct += cloudPct < 60 ? 7 : 3;
        reportProgress(Math.min(88, cloudPct), 'Generating meeting notes...');
      }
    }, 650);

    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      },
      60000
    );

    clearInterval(cloudTickerInterval);
    cloudTickerInterval = null;

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

    await reportProgress(96, 'Saving Markdown file...');

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
    await reportProgress(100, 'Completed');

    if (isHistoryRegen) {
      await updateRecentMeetingTitle(overrideMeeting.id, chosenTitle);
    } else {
      await updateRecentMeetingTitle(savedEntry ? savedEntry.id : result.startTime, chosenTitle);
      await chrome.storage.local.set({
        notesStatus: 'done',
        notesError: '',
        notesProgress: 100,
        notesStage: 'Completed',
        completionUnseen: true
      });
    }

    return { status: "done", filename };
  } catch (error) {
    console.error("mast: Generation failed:", error);
    if (isHistoryRegen) {
      try {
        await chrome.storage.local.set({
          historyRegenProgress: {
            meetingId: String(overrideMeeting.id),
            progress: 0,
            stage: '',
            active: false
          }
        });
      } catch (_) {}
    } else {
      await chrome.storage.local.set({
        notesStatus: 'error',
        notesError: error.message || "Failed to generate AI summary.",
        notesProgress: 0,
        notesStage: ''
      });
    }
    return { status: "error", error: error.message };
  } finally {
    if (cloudTickerInterval) {
      clearInterval(cloudTickerInterval);
    }
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

async function downloadHistoryTranscript(meetingId) {
  const stored = await chrome.storage.local.get(['recentMeetings']);
  const recent = Array.isArray(stored.recentMeetings) ? stored.recentMeetings : [];
  const target = recent.find((m) => m.id === String(meetingId));
  if (!target || !target.lines || target.lines.length === 0) {
    return { status: "error", error: "Meeting transcript not found in storage." };
  }
  const fullTranscript = target.lines.join('\n');
  const meetingName = sanitizeFilenameTitle(target.teamsTitle || target.title, 'meeting');
  const shortDate = target.shortDate || formatShortDate(new Date(target.timestamp || Date.now()));
  const filename = `transcript_${meetingName}_${shortDate}.txt`;
  try {
    await downloadTextViaDataUrl(fullTranscript, 'text/plain', filename);
    return { status: "downloaded", filename };
  } catch (err) {
    return { status: "error", error: err.message || "Failed to download transcript." };
  }
}

async function deleteRecentMeeting(meetingId) {
  const stored = await chrome.storage.local.get(['recentMeetings', 'startTime', 'isTranscribing']);
  const recent = Array.isArray(stored.recentMeetings) ? stored.recentMeetings : [];
  const updated = recent.filter((m) => m.id !== String(meetingId));
  const updates = { recentMeetings: updated };
  if (!stored.isTranscribing && String(stored.startTime) === String(meetingId)) {
    updates.savedTranscript = [];
    updates.notesStatus = 'idle';
    updates.notesError = '';
  }
  await chrome.storage.local.set(updates);
  return { status: "deleted", recentMeetings: updated };
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
    pillDismissedInCall: false,
    notesStatus: 'idle',
    notesError: '',
    notesProgress: 0,
    notesStage: '',
    completionUnseen: false,
    transcriptDownloaded: false,
    callEnded: false,
    liveCaptionsOn: true,
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

cleanupLegacyState();
injectContentScriptIntoOpenTeamsTabs();
syncToolbarBadge();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (
    changes.isTranscribing ||
    changes.liveCaptionsOn ||
    changes.notesStatus ||
    changes.inActiveCall ||
    changes.completionUnseen
  ) {
    syncToolbarBadge();
  }
});

// Auto-migrate model selection, inject content script, and recover any interrupted generation on install/reload
chrome.runtime.onInstalled.addListener(async () => {
  await cleanupLegacyState();
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
  await cleanupLegacyState();
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
    const hasLines = result.savedTranscript && result.savedTranscript.length > 0;
    if (result.isTranscribing || (result.notesStatus === 'generating' && !isGeneratingInMemory)) {
      await chrome.storage.local.set({ isTranscribing: false, callEnded: true, activeTabId: null });
      if (hasLines) {
        await handleSessionEnded();
        return;
      }
    }
    const afterState = await chrome.storage.local.get(['notesStatus', 'savedTranscript']);
    const afterHasLines = afterState.savedTranscript && afterState.savedTranscript.length > 0;
    if (
      !isGeneratingInMemory &&
      afterState.notesStatus !== 'error' &&
      !(afterState.notesStatus === 'done' && afterHasLines)
    ) {
      await chrome.storage.local.set({
        savedTranscript: [],
        activeTabId: null,
        inActiveCall: false,
        pillDismissedInCall: false,
        notesStatus: 'idle',
        notesError: '',
        notesProgress: 0,
        notesStage: '',
        completionUnseen: false,
        transcriptDownloaded: false,
        meetingTitle: 'Meeting'
      });
    } else {
      await chrome.storage.local.set({ activeTabId: null, inActiveCall: false, pillDismissedInCall: false });
    }
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "get_worker_version") {
    sendResponse({ version: WORKER_BUILD_VERSION });
    return false;
  } else if (request.action === "start_from_toast") {
    startFromToast(sender, request.meetingTitle)
      .then(sendResponse)
      .catch((err) => sendResponse({ status: "error", error: err && err.message ? err.message : "Failed to start" }));
    return true;
  } else if (request.action === "open_options") {
    try {
      chrome.runtime.openOptionsPage();
    } catch (_) {}
    sendResponse({ status: "opened" });
    return false;
  } else if (request.action === "session_ended") {
    handleSessionEnded()
      .then(sendResponse)
      .catch((err) => sendResponse({ status: "error", error: err && err.message ? err.message : "Failed" }));
    return true;
  } else if (request.action === "stop_and_finalize") {
    stopTabAndFinalize(request.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ status: "error", error: err && err.message ? err.message : "Failed" }));
    return true;
  } else if (request.action === "check_generation_status") {
    recoverStuckGenerationIfNeeded()
      .then(sendResponse)
      .catch((err) => sendResponse({ status: "error", error: err && err.message ? err.message : "Failed" }));
    return true;
  } else if (request.action === "generate_notes") {
    generateAndDownloadNotes()
      .then(sendResponse)
      .catch((err) => sendResponse({ status: "error", error: err && err.message ? err.message : "Failed" }));
    return true;
  } else if (request.action === "regenerate_meeting_notes") {
    regenerateMeetingFromHistory(request.meetingId)
      .then(sendResponse)
      .catch((err) => sendResponse({ status: "error", error: err && err.message ? err.message : "Failed" }));
    return true;
  } else if (request.action === "download_history_transcript") {
    downloadHistoryTranscript(request.meetingId)
      .then(sendResponse)
      .catch((err) => sendResponse({ status: "error", error: err && err.message ? err.message : "Failed" }));
    return true;
  } else if (request.action === "delete_recent_meeting") {
    deleteRecentMeeting(request.meetingId)
      .then(sendResponse)
      .catch((err) => sendResponse({ status: "error", error: err && err.message ? err.message : "Failed" }));
    return true;
  } else if (request.action === "download_transcript") {
    downloadTranscriptIfNeeded(true)
      .then(() => sendResponse({ status: "downloaded" }))
      .catch((err) => sendResponse({ status: "error", error: err.message }));
    return true;
  }
});
