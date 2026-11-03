// Background Service Worker for mast (Meeting AI Summarizer & Transcriber for MS Teams)

const WORKER_BUILD_VERSION = '2.9.5';
const GEMMA_MODEL_ID = 'gemma-4-e2b-it';
const LEGACY_NANO_MODEL_ID = 'gemini-nano';
const GEMMA_MODEL_URL =
  'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q3_K_S.gguf';
const MIN_FREE_DISK_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB

let isGeneratingInMemory = false;
const activeBridgeProgressHandlers = new Map();

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

function normalizeSimMode(rawMode) {
  if (rawMode === 'low_disk' || rawMode === 'downloadable') return rawMode;
  return 'real';
}

async function isGemmaCachedInOPFS() {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
      return false;
    }
    const root = await navigator.storage.getDirectory();
    const cacheDir = await root.getDirectoryHandle('cache', { create: false });
    const hashBuf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(GEMMA_MODEL_URL));
    const hashHex = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const fileKey = `${hashHex}_gemma-4-E2B-it-Q3_K_S.gguf`;
    const fileHandle = await cacheDir.getFileHandle(fileKey, { create: false });
    const file = await fileHandle.getFile();
    if (!file || file.size < 2000000000) return false;
    try {
      const metaHandle = await cacheDir.getFileHandle(`__metadata__${fileKey}`, { create: false });
      const metaFile = await metaHandle.getFile();
      const meta = JSON.parse(await metaFile.text());
      if (meta && meta.originalSize && file.size !== meta.originalSize) return false;
    } catch (_) {}
    return true;
  } catch (_) {
    return false;
  }
}

function getGemmaUnavailableErrorMessage(reason) {
  if (reason === 'low_disk') {
    return 'At least 3 GB of free disk space is required for Gemma On-Device.';
  }
  return 'Gemma On-Device is unavailable in this browser.';
}

async function checkGemmaAvailability(simModeOverride = null) {
  let rawMode = simModeOverride;
  if (!rawMode) {
    try {
      const stored = await chrome.storage.local.get(['devNanoSimMode']);
      rawMode = stored.devNanoSimMode || 'real';
    } catch (_) {
      rawMode = 'real';
    }
  }
  const simMode = normalizeSimMode(rawMode);

  if (simMode === 'low_disk') {
    return { status: 'unavailable', simulated: true, reason: 'low_disk' };
  }
  if (simMode === 'downloadable') {
    return { status: 'downloadable', simulated: true, reason: 'simulated_download' };
  }

  if (await isGemmaCachedInOPFS()) {
    return { status: 'available', simulated: false, reason: 'ok' };
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
      const est = await navigator.storage.estimate();
      if (est && typeof est.quota === 'number' && est.quota > 0) {
        const remaining = est.quota - (est.usage || 0);
        if (remaining < MIN_FREE_DISK_BYTES) {
          return { status: 'unavailable', simulated: false, reason: 'low_disk' };
        }
      }
    }
  } catch (_) {}

  return { status: 'downloadable', simulated: false, reason: 'needs_download' };
}

function getEffectiveAiMode(storedState = {}) {
  if (storedState.aiMode === 'gemma' || storedState.aiMode === 'nano') return 'gemma';
  if (storedState.aiMode === 'cloud') return 'cloud';
  if (
    storedState.modelSelectVal === GEMMA_MODEL_ID ||
    storedState.selectedModel === GEMMA_MODEL_ID ||
    storedState.modelSelectVal === LEGACY_NANO_MODEL_ID ||
    storedState.selectedModel === LEGACY_NANO_MODEL_ID
  ) {
    return 'gemma';
  }
  if (
    storedState.onboardingCompleted !== false &&
    storedState.apiKey &&
    storedState.apiKey.trim()
  ) {
    return 'cloud';
  }
  return 'unconfigured';
}

async function resolveActiveModel(apiKey, storedState = {}) {
  const mode = getEffectiveAiMode(storedState);
  if (mode === 'gemma') {
    return GEMMA_MODEL_ID;
  }
  if (mode === 'unconfigured') {
    return '';
  }

  const cleanKey = apiKey ? apiKey.trim() : '';
  if (!cleanKey) {
    return '';
  }

  if (storedState.modelSelectVal === 'custom' && storedState.customModelVal) {
    return storedState.customModelVal.trim().replace(/^models\//, '');
  }

  try {
    const response = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${cleanKey}`,
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

function buildMinutesPrompt(sourceText, dateFormatted) {
  return `## Role

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
8.  **Action items:** Identify who is responsible for what action and by when. Write these items clearly. (e.g., "John - finalize vendor contract by March 15.")
9.  **Follow-ups:** Note any unresolved issues or topics that were deferred to future meetings.

Note: The meeting took place on ${dateFormatted}.

Transcript:
${sourceText}`;
}

async function findOpenOptionsTabId() {
  try {
    if (typeof chrome.runtime.getContexts === 'function') {
      const optionsPrefix = chrome.runtime.getURL('options.html');
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
      const match = (contexts || []).find(
        (c) =>
          c.documentUrl &&
          c.documentUrl.startsWith(optionsPrefix) &&
          typeof c.tabId === 'number' &&
          c.tabId >= 0
      );
      if (match) return match.tabId;
    }
  } catch (_) {}
  return null;
}

async function generateNotesWithGemmaViaBridge(lines, dateFormatted, rawSimMode, onProgress) {
  const simMode = normalizeSimMode(rawSimMode);
  if (simMode === 'low_disk') {
    const err = new Error(getGemmaUnavailableErrorMessage('low_disk'));
    err.code = 'NANO_UNAVAILABLE';
    err.reason = 'low_disk';
    throw err;
  }

  const avail = await checkGemmaAvailability('real');
  if (avail.status === 'unavailable' && simMode !== 'downloadable') {
    const err = new Error(getGemmaUnavailableErrorMessage(avail.reason || 'low_disk'));
    err.code = 'NANO_UNAVAILABLE';
    err.reason = avail.reason || 'low_disk';
    throw err;
  }

  const channel = `gemma_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  activeBridgeProgressHandlers.set(channel, onProgress);

  const payload = {
    action: 'bridge_gemma_generate',
    lines,
    dateFormatted,
    simMode,
    channel
  };

  const sendToTab = (tabId) =>
    new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, payload, (res) => {
          if (chrome.runtime.lastError || !res) {
            resolve(null);
          } else {
            resolve(res);
          }
        });
      } catch (_) {
        resolve(null);
      }
    });

  const sendBroadcast = () =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (res) => {
          if (chrome.runtime.lastError || !res) {
            resolve(null);
          } else {
            resolve(res);
          }
        });
      } catch (_) {
        resolve(null);
      }
    });

  let spawnedTabId = null;

  try {
    let res = null;
    const existingTabId = await findOpenOptionsTabId();
    if (existingTabId !== null) {
      res = await sendToTab(existingTabId);
    } else {
      res = await sendBroadcast();
    }

    if (!res) {
      const createdTab = await new Promise((resolve) => {
        chrome.tabs.create(
          { url: chrome.runtime.getURL('options.html?bg_infer=1'), active: false },
          (tab) => {
            void chrome.runtime.lastError;
            resolve(tab || null);
          }
        );
      });
      if (createdTab && createdTab.id) {
        spawnedTabId = createdTab.id;
        for (let attempt = 0; attempt < 24; attempt++) {
          await new Promise((r) => setTimeout(r, 250));
          res = await sendToTab(spawnedTabId);
          if (res) break;
        }
      }
    }

    if (!res) {
      throw new Error('Could not initialize local Gemma 4 E2B worker. Please click Retry.');
    }

    if (!res.ok) {
      const err = new Error(res.error || getGemmaUnavailableErrorMessage(res.reason || 'unknown'));
      if (res.code) err.code = res.code;
      if (res.reason) err.reason = res.reason;
      throw err;
    }

    return res.minutesText;
  } finally {
    activeBridgeProgressHandlers.delete(channel);
    if (spawnedTabId) {
      try {
        chrome.tabs.remove(spawnedTabId, () => {
          void chrome.runtime.lastError;
        });
      } catch (_) {}
    }
  }
}

async function generateAndDownloadNotes(overrideMeeting = null) {
  const isHistoryRegen = !!overrideMeeting;
  if (!isHistoryRegen && isGeneratingInMemory) {
    return { status: "already_generating" };
  }
  if (!isHistoryRegen) {
    isGeneratingInMemory = true;
  }

  // Keep MV3 service worker alive & refresh popup heartbeat during long local/cloud runs
  const keepAliveInterval = setInterval(() => {
    if (!isHistoryRegen) {
      chrome.storage.local.set({ generationHeartbeatAt: Date.now() }, () => {
        void chrome.runtime.lastError;
      });
    } else {
      chrome.storage.local.get(['notesStatus'], () => {
        void chrome.runtime.lastError;
      });
    }
  }, 5000);

  let cloudTickerInterval = null;
  let lastProgressWriteAt = 0;
  let lastStageWritten = '';

  const reportProgress = async (progress, stage, force = false) => {
    const clamped = Math.max(0, Math.min(100, Math.round(progress)));
    const now = Date.now();
    if (!force && stage === lastStageWritten && clamped < 100 && now - lastProgressWriteAt < 220) {
      return;
    }
    lastProgressWriteAt = now;
    lastStageWritten = stage;
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
          notesStage: stage || '',
          generationHeartbeatAt: now
        });
      }
    } catch (_) {}
  };

  try {
    const result = await chrome.storage.local.get([
      'savedTranscript',
      'apiKey',
      'aiMode',
      'onboardingCompleted',
      'selectedModel',
      'modelSelectVal',
      'customModelVal',
      'userSelectedModel',
      'meetingTitle',
      'titleSource',
      'startTime',
      'devNanoSimMode'
    ]);

    const lines = isHistoryRegen ? (overrideMeeting.lines || []) : (result.savedTranscript || []);
    if (lines.length === 0) {
      if (!isHistoryRegen) {
        await chrome.storage.local.set({
          notesStatus: 'error',
          notesError: 'No captions captured.',
          notesErrorCode: ''
        });
      }
      return { status: "error", error: "No captions captured." };
    }

    const effectiveMode = getEffectiveAiMode(result);
    if (effectiveMode === 'unconfigured') {
      const msg = 'Please choose Gemma On-Device or Gemini Flash in Settings first.';
      if (!isHistoryRegen) {
        await chrome.storage.local.set({
          notesStatus: 'error',
          notesError: msg,
          notesErrorCode: ''
        });
      }
      return { status: "error", error: msg };
    }

    const apiKey = result.apiKey ? result.apiKey.trim() : '';
    const isOnDeviceModel = effectiveMode === 'gemma';

    if (!isOnDeviceModel && !apiKey) {
      const msg = 'API key missing. Enter a Google AI Studio API key or choose Gemma On-Device in Settings.';
      if (!isHistoryRegen) {
        await chrome.storage.local.set({
          notesStatus: 'error',
          notesError: msg,
          notesErrorCode: ''
        });
      }
      return { status: "error", error: msg };
    }

    const model = isOnDeviceModel ? GEMMA_MODEL_ID : await resolveActiveModel(apiKey, result);

    let savedEntry = null;
    const nowTs = Date.now();
    if (!isHistoryRegen) {
      savedEntry = await saveToRecentMeetings(lines, result.meetingTitle, result.startTime);
      await chrome.storage.local.set({
        notesStatus: 'generating',
        notesError: '',
        notesErrorCode: '',
        notesErrorReason: '',
        notesProgress: 5,
        notesStage: isOnDeviceModel
          ? 'Preparing Gemma 4 E2B (On-Device)...'
          : 'Connecting to Gemini...',
        generationStartedAt: nowTs,
        generationHeartbeatAt: nowTs
      });
    } else {
      await reportProgress(
        5,
        isOnDeviceModel ? 'Preparing Gemma 4 E2B (On-Device)...' : 'Connecting to Gemini...',
        true
      );
    }

    const dateObj = isHistoryRegen && overrideMeeting.timestamp ? new Date(overrideMeeting.timestamp) : new Date();
    const dateFormatted =
      dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) +
      ' at ' +
      dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) +
      ' UTC';

    let minutesText = '';

    if (isOnDeviceModel) {
      const simMode = normalizeSimMode(result.devNanoSimMode || 'real');
      minutesText = await generateNotesWithGemmaViaBridge(lines, dateFormatted, simMode, (pct, stage) =>
        reportProgress(pct, stage, false)
      );
    } else {
      const fullTranscript = lines.join('\n');
      const prompt = buildMinutesPrompt(fullTranscript, dateFormatted);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 }
      };

      let cloudPct = 20;
      await reportProgress(cloudPct, 'Generating meeting notes...', true);
      cloudTickerInterval = setInterval(() => {
        if (cloudPct < 88) {
          cloudPct += cloudPct < 60 ? 7 : 3;
          reportProgress(Math.min(88, cloudPct), 'Generating meeting notes...', true);
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
      minutesText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!minutesText) {
        throw new Error("Empty response from Gemini model.");
      }
    }

    await reportProgress(96, 'Saving Markdown file...', true);

    const rawTeamsTitle = isHistoryRegen
      ? (overrideMeeting.teamsTitle || overrideMeeting.title)
      : result.meetingTitle;
    const hasTeamsTitle =
      rawTeamsTitle &&
      typeof rawTeamsTitle === 'string' &&
      rawTeamsTitle.trim() &&
      rawTeamsTitle.trim().toLowerCase() !== 'meeting';

    let aiTitle = "meeting";
    if (!isOnDeviceModel) {
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
    } else if (!minutesText.trimStart().startsWith('#')) {
      const headingTitle = hasTeamsTitle ? rawTeamsTitle.trim() : 'Meeting Notes';
      minutesText = `# ${headingTitle}\n\n${minutesText.trimStart()}`;
    }

    const useTeamsTitle = isOnDeviceModel || result.titleSource === 'teams';
    const chosenTitle = isOnDeviceModel
      ? (hasTeamsTitle ? rawTeamsTitle.trim() : 'meeting')
      : (useTeamsTitle && hasTeamsTitle ? rawTeamsTitle.trim() : aiTitle);
    const sanitizedTitle = sanitizeFilenameTitle(chosenTitle, 'meeting');
    const shortDate = isHistoryRegen && overrideMeeting.shortDate ? overrideMeeting.shortDate : formatShortDate(dateObj);
    const filename = `${sanitizedTitle}_${shortDate}.md`;

    await downloadTextViaDataUrl(minutesText, 'text/markdown', filename);
    await reportProgress(100, 'Completed', true);

    if (isHistoryRegen) {
      await updateRecentMeetingTitle(overrideMeeting.id, chosenTitle);
    } else {
      await updateRecentMeetingTitle(savedEntry ? savedEntry.id : result.startTime, chosenTitle);
      await chrome.storage.local.set({
        notesStatus: 'done',
        notesError: '',
        notesErrorCode: '',
        notesErrorReason: '',
        notesProgress: 100,
        notesStage: 'Completed',
        completionUnseen: true
      });
    }

    return { status: "done", filename };
  } catch (error) {
    console.error("mast: Generation failed:", error);
    const errCode = error && error.code === 'NANO_UNAVAILABLE' ? 'nano_unavailable' : '';
    const errReason = error && error.reason ? error.reason : '';
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
        notesErrorCode: errCode,
        notesErrorReason: errReason,
        notesProgress: 0,
        notesStage: ''
      });
    }
    return { status: "error", error: error.message, errorCode: errCode, errorReason: errReason };
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

async function startFromToast(sender, meetingTitle, chosenMode = null) {
  const stored = await chrome.storage.local.get([
    'apiKey',
    'aiMode',
    'onboardingCompleted',
    'selectedModel',
    'modelSelectVal',
    'customModelVal',
    'userSelectedModel',
    'devNanoSimMode'
  ]);

  if (chosenMode === 'gemma' || chosenMode === 'nano') {
    await chrome.storage.local.set({
      aiMode: 'gemma',
      selectedModel: GEMMA_MODEL_ID,
      modelSelectVal: GEMMA_MODEL_ID,
      userSelectedModel: true,
      onboardingCompleted: true
    });
    stored.aiMode = 'gemma';
    stored.selectedModel = GEMMA_MODEL_ID;
    stored.modelSelectVal = GEMMA_MODEL_ID;
    stored.onboardingCompleted = true;
  } else if (chosenMode === 'cloud') {
    await chrome.storage.local.set({ aiMode: 'cloud' });
    stored.aiMode = 'cloud';
  }

  const cleanKey = stored.apiKey ? stored.apiKey.trim() : '';
  const effectiveMode = getEffectiveAiMode(stored);

  if (effectiveMode === 'unconfigured') {
    return { status: "choose_mode" };
  }

  if (effectiveMode === 'gemma') {
    const gemmaAvail = await checkGemmaAvailability(stored.devNanoSimMode || null);
    if (gemmaAvail.status === 'unavailable') {
      chrome.runtime.openOptionsPage();
      return { status: "nano_unavailable", reason: gemmaAvail.reason || 'low_disk' };
    }
  } else if (!cleanKey) {
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
    notesErrorCode: '',
    notesErrorReason: '',
    notesProgress: 0,
    notesStage: '',
    completionUnseen: false,
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
    'aiMode',
    'onboardingCompleted',
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
  if (getEffectiveAiMode(result) === 'cloud' && result.apiKey) {
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
        notesStatus: 'idle',
        notesError: '',
        completionUnseen: false,
        transcriptDownloaded: false,
        meetingTitle: 'Meeting'
      });
    } else {
      await chrome.storage.local.set({ activeTabId: null });
    }
  }
});

// [DEV-ONLY] Test uploaded transcript on Gemma On-Device
async function runDevTranscriptGemmaTest(request) {
  const lines = Array.isArray(request.lines) ? request.lines : [];
  if (lines.length === 0) {
    return { status: 'error', error: 'Uploaded transcript is empty.' };
  }

  const startedAt = Date.now();
  const stored = await chrome.storage.local.get(['devNanoSimMode']);
  const simMode = normalizeSimMode(request.simMode || stored.devNanoSimMode || 'real');
  const rawTitle = request.meetingTitle && String(request.meetingTitle).trim()
    ? String(request.meetingTitle).trim()
    : 'Meeting';
  const hasTitle = rawTitle.toLowerCase() !== 'meeting';

  const keepAliveInterval = setInterval(() => {
    chrome.storage.local.get(['devNanoSimMode'], () => {});
  }, 5000);

  let lastWriteAt = 0;
  let lastStage = '';
  const onProgress = async (pct, stage, force = false) => {
    const clamped = Math.max(0, Math.min(100, Math.round(pct || 0)));
    const now = Date.now();
    if (!force && stage === lastStage && clamped < 100 && now - lastWriteAt < 180) {
      return;
    }
    lastWriteAt = now;
    lastStage = stage || '';
    try {
      await chrome.storage.local.set({
        devTranscriptTestProgress: {
          active: clamped < 100,
          progress: clamped,
          stage: stage || ''
        }
      });
    } catch (_) {}
  };

  try {
    await onProgress(5, 'Preparing Gemma 4 E2B (On-Device)...', true);
    const dateObj = new Date();
    const dateFormatted =
      dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) +
      ' at ' +
      dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) +
      ' UTC';

    let minutesText = await generateNotesWithGemmaViaBridge(lines, dateFormatted, simMode, (pct, stage) =>
      onProgress(pct, stage, false)
    );

    if (!minutesText.trimStart().startsWith('#')) {
      const headingTitle = hasTitle ? rawTitle : 'Meeting Notes';
      minutesText = `# ${headingTitle}\n\n${minutesText.trimStart()}`;
    }

    await onProgress(96, 'Saving Markdown file...', true);
    const sanitizedTitle = sanitizeFilenameTitle(hasTitle ? rawTitle : 'meeting', 'meeting');
    const filename = `${sanitizedTitle}_${formatShortDate(dateObj)}.md`;
    await downloadTextViaDataUrl(minutesText, 'text/markdown', filename);
    await onProgress(100, 'Completed', true);

    return {
      status: 'done',
      summary: minutesText,
      filename,
      elapsedMs: Date.now() - startedAt
    };
  } catch (error) {
    try {
      await chrome.storage.local.set({
        devTranscriptTestProgress: {
          active: false,
          progress: 0,
          stage: ''
        }
      });
    } catch (_) {}
    return {
      status: 'error',
      error: error.message || 'Failed to summarize uploaded transcript.',
      errorCode: error && error.code === 'NANO_UNAVAILABLE' ? 'nano_unavailable' : '',
      errorReason: error && error.reason ? error.reason : ''
    };
  } finally {
    clearInterval(keepAliveInterval);
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "get_worker_version") {
    sendResponse({ version: WORKER_BUILD_VERSION });
    return false;
  } else if (request.action === "bridge_gemma_progress" || request.action === "bridge_nano_progress") {
    const handler = request.channel && activeBridgeProgressHandlers.get(request.channel);
    if (handler) {
      handler(request.pct, request.stage);
    }
    sendResponse({ status: "ack" });
    return false;
  } else if (request.action === "dev_test_gemma_transcript" || request.action === "dev_test_nano_transcript") {
    runDevTranscriptGemmaTest(request).then(sendResponse);
    return true;
  } else if (request.action === "get_gemma_availability" || request.action === "get_nano_availability") {
    checkGemmaAvailability(request.simMode || null).then(sendResponse);
    return true;
  } else if (request.action === "open_chrome_url") {
    if (request.url && typeof request.url === "string" && request.url.startsWith("chrome://")) {
      chrome.tabs.create({ url: request.url }, () => {
        void chrome.runtime.lastError;
      });
    }
    sendResponse({ status: "opened" });
    return false;
  } else if (request.action === "start_from_toast") {
    startFromToast(sender, request.meetingTitle, request.chosenMode || null).then(sendResponse);
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
  } else if (request.action === "download_history_transcript") {
    downloadHistoryTranscript(request.meetingId).then(sendResponse);
    return true;
  } else if (request.action === "delete_recent_meeting") {
    deleteRecentMeeting(request.meetingId).then(sendResponse);
    return true;
  } else if (request.action === "download_transcript") {
    downloadTranscriptIfNeeded(true)
      .then(() => sendResponse({ status: "downloaded" }))
      .catch((err) => sendResponse({ status: "error", error: err.message }));
    return true;
  }
});
