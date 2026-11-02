// Background Service Worker for mast (Meeting AI Summarizer & Transcriber for MS Teams)

const WORKER_BUILD_VERSION = '2.9.1';
const GEMINI_NANO_MODEL_ID = 'gemini-nano';
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

function getLanguageModelNamespace() {
  if (typeof LanguageModel !== 'undefined') return LanguageModel;
  if (typeof self !== 'undefined' && self.LanguageModel) return self.LanguageModel;
  if (typeof self !== 'undefined' && self.ai && self.ai.languageModel) return self.ai.languageModel;
  return null;
}

async function checkGeminiNanoAvailability(simModeOverride = null) {
  let simMode = simModeOverride;
  if (!simMode) {
    try {
      const stored = await chrome.storage.local.get(['devNanoSimMode']);
      simMode = stored.devNanoSimMode || 'real';
    } catch (_) {
      simMode = 'real';
    }
  }

  if (simMode === 'low_disk') {
    return { status: 'unavailable', simulated: true, reason: 'low_disk' };
  }
  if (simMode === 'downloadable') {
    return { status: 'downloadable', simulated: true, reason: 'simulated_download' };
  }

  const lm = getLanguageModelNamespace();
  if (!lm) {
    return { status: 'unavailable', simulated: false, reason: 'api_missing' };
  }

  try {
    if (typeof lm.availability === 'function') {
      let rawStatus;
      try {
        rawStatus = await lm.availability({
          expectedInputs: [{ type: 'text', languages: ['en'] }],
          expectedOutputs: [{ type: 'text', languages: ['en'] }]
        });
      } catch (_) {
        rawStatus = await lm.availability();
      }
      if (rawStatus === 'available' || rawStatus === 'readily') {
        return { status: 'available', simulated: false, reason: 'ok' };
      }
      if (rawStatus === 'downloadable' || rawStatus === 'after-download') {
        return { status: 'downloadable', simulated: false, reason: 'needs_download' };
      }
      if (rawStatus === 'downloading') {
        return { status: 'downloading', simulated: false, reason: 'downloading' };
      }
      return { status: 'unavailable', simulated: false, reason: 'device_unavailable' };
    }

    if (typeof lm.capabilities === 'function') {
      const caps = await lm.capabilities();
      const avail = caps && caps.available;
      if (avail === 'readily') {
        return { status: 'available', simulated: false, reason: 'ok' };
      }
      if (avail === 'after-download') {
        return { status: 'downloadable', simulated: false, reason: 'needs_download' };
      }
    }
  } catch (err) {
    console.warn('mast: Gemini Nano availability check failed:', err);
  }

  return { status: 'unavailable', simulated: false, reason: 'device_unavailable' };
}

function getEffectiveAiMode(storedState = {}) {
  if (storedState.aiMode === 'nano') return 'nano';
  if (storedState.aiMode === 'cloud') return 'cloud';
  if (
    storedState.modelSelectVal === GEMINI_NANO_MODEL_ID ||
    storedState.selectedModel === GEMINI_NANO_MODEL_ID
  ) {
    return 'nano';
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
  if (mode === 'nano') {
    return GEMINI_NANO_MODEL_ID;
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

const NANO_SYSTEM_PROMPT =
  'You are an expert meeting minutes generator. Produce clear, accurate, concise Markdown meeting notes strictly grounded in the provided transcript. Never invent facts, attendees, or action items.';

function buildMinutesPrompt(sourceText, dateFormatted, isFromChunkSummaries = false) {
  const sourceLabel = isFromChunkSummaries ? 'Segment Summaries' : 'Transcript';
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

${sourceLabel}:
${sourceText}`;
}

async function createNanoSession(lm, systemPrompt, monitorCb = null) {
  let temperature = 0.2;
  let topK = 3;
  try {
    if (typeof lm.params === 'function') {
      const params = await lm.params();
      if (params) {
        if (typeof params.maxTopK === 'number' && params.maxTopK >= 1) {
          topK = Math.min(3, Math.max(1, Math.floor(params.maxTopK)));
        }
        if (typeof params.maxTemperature === 'number') {
          temperature = Math.min(0.2, params.maxTemperature);
        }
      }
    }
  } catch (_) {}

  const baseOpts = {
    temperature,
    topK,
    initialPrompts: [{ role: 'system', content: systemPrompt }]
  };
  if (monitorCb) {
    baseOpts.monitor = monitorCb;
  }

  try {
    return await lm.create({
      ...baseOpts,
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }]
    });
  } catch (_) {
    try {
      return await lm.create(baseOpts);
    } catch (_) {
      const legacyOpts = { systemPrompt };
      if (monitorCb) legacyOpts.monitor = monitorCb;
      return await lm.create(legacyOpts);
    }
  }
}

async function promptNanoStreaming(session, promptText, onProgressText) {
  if (typeof session.promptStreaming === 'function') {
    const stream = session.promptStreaming(promptText);
    let accumulated = '';
    for await (const chunk of stream) {
      const piece = typeof chunk === 'string' ? chunk : String(chunk || '');
      if (!piece) continue;
      if (accumulated.length > 10 && piece.startsWith(accumulated)) {
        accumulated = piece;
      } else {
        accumulated += piece;
      }
      if (onProgressText) {
        onProgressText(accumulated);
      }
    }
    if (accumulated.trim()) {
      return accumulated;
    }
  }
  const full = await session.prompt(promptText);
  if (onProgressText) {
    onProgressText(full || '');
  }
  return full || '';
}

function splitTranscriptIntoChunks(lines, maxCharsPerChunk = 6500) {
  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const rawLine of lines) {
    const line = String(rawLine || '');
    if (line.length > maxCharsPerChunk) {
      if (current.length > 0) {
        chunks.push(current.join('\n'));
        current = [];
        currentLen = 0;
      }
      for (let i = 0; i < line.length; i += maxCharsPerChunk) {
        chunks.push(line.slice(i, i + maxCharsPerChunk));
      }
      continue;
    }
    if (currentLen + line.length + 1 > maxCharsPerChunk && current.length > 0) {
      chunks.push(current.join('\n'));
      current = [line];
      currentLen = line.length;
    } else {
      current.push(line);
      currentLen += line.length + 1;
    }
  }

  if (current.length > 0) {
    chunks.push(current.join('\n'));
  }
  return chunks;
}

async function runSimulatedNanoFallback(lines, dateFormatted, onProgress) {
  const speakers = new Set();
  for (const line of lines) {
    const match = String(line).match(/^\[([^\]]+)\]:/);
    if (match && match[1] && match[1] !== 'Unknown') {
      speakers.add(match[1].trim());
    }
  }
  const attendeeList = speakers.size > 0 ? Array.from(speakers).join(', ') : 'Meeting Participants';
  const samplePoints = lines
    .slice(0, 5)
    .map((l) => `    *   ${String(l).substring(0, 140)}`)
    .join('\n');

  const stages = [
    [45, 'Analyzing transcript on-device...'],
    [65, 'Extracting discussions and action items...'],
    [85, 'Drafting meeting notes...'],
    [94, 'Formatting Markdown output...']
  ];
  for (const [pct, label] of stages) {
    await onProgress(pct, label);
    await new Promise((r) => setTimeout(r, 550));
  }

  return `# Title
Simulated On-Device Meeting Summary

*   **Date, time, and attendees:**
    *   ${dateFormatted}
    *   Attendees: ${attendeeList}
*   **Meeting purpose:** Review captured Microsoft Teams discussion (generated via DEV simulation mode on a host where the hardware on-device model is not installed).
*   **Agenda items:**
    *   Captured transcript review (${lines.length} caption segments)
*   **Key discussions:**
${samplePoints || '    *   Discussion captured from live captions.'}
*   **Decisions made:**
    *   **Verified end-to-end download and generation progress bar in DEV simulation mode.**
*   **Action items:**
    *   Team - review generated notes in Downloads folder.
*   **Follow-ups:**
    *   Switch DEV Simulate toggle back to Real Device for hardware inference.`;
}

async function generateNotesWithGeminiNano(lines, dateFormatted, simMode, onProgress) {
  if (simMode === 'low_disk') {
    const err = new Error(
      'Gemini Nano (On-Device) is unavailable. At least 22 GB of free disk space is required.'
    );
    err.code = 'NANO_UNAVAILABLE';
    throw err;
  }

  let baseStartPct = 12;
  if (simMode === 'downloadable') {
    const simSteps = [0, 14, 31, 52, 74, 91, 100];
    for (const dlPct of simSteps) {
      const mappedPct = 6 + Math.round(dlPct * 0.30);
      await onProgress(mappedPct, `Downloading Gemini Nano (On-Device) (${dlPct}%)...`);
      await new Promise((r) => setTimeout(r, 450));
    }
    baseStartPct = 38;
  }

  const realAvail = await checkGeminiNanoAvailability('real');
  if (realAvail.status === 'unavailable') {
    if (simMode === 'downloadable') {
      return await runSimulatedNanoFallback(lines, dateFormatted, onProgress);
    }
    const err = new Error(
      'Gemini Nano (On-Device) is unavailable on this device (requires 22 GB free disk space).'
    );
    err.code = 'NANO_UNAVAILABLE';
    throw err;
  }

  const lm = getLanguageModelNamespace();
  if (!lm) {
    const err = new Error('Gemini Nano (On-Device) is not supported in this browser version.');
    err.code = 'NANO_UNAVAILABLE';
    throw err;
  }

  await onProgress(
    baseStartPct,
    realAvail.status === 'downloadable' || realAvail.status === 'downloading'
      ? 'Downloading Gemini Nano (On-Device)...'
      : 'Loading Gemini Nano (On-Device)...'
  );

  let session = null;
  try {
    session = await createNanoSession(lm, NANO_SYSTEM_PROMPT, (m) => {
      try {
        m.addEventListener('downloadprogress', (e) => {
          const rawRatio =
            typeof e.loaded === 'number'
              ? e.total && e.total > 0
                ? e.loaded / e.total
                : e.loaded
              : 0;
          const dlPct = Math.min(100, Math.max(0, Math.round(rawRatio * 100)));
          const overallPct = 6 + Math.round(dlPct * 0.30);
          onProgress(overallPct, `Downloading Gemini Nano (On-Device) (${dlPct}%)...`);
        });
      } catch (_) {}
    });

    const fullTranscript = lines.join('\n');
    const singlePassPrompt = buildMinutesPrompt(fullTranscript, dateFormatted, false);

    let inputTokens = Math.ceil(singlePassPrompt.length / 3.5);
    const inputQuota = session && typeof session.inputQuota === 'number' && session.inputQuota > 0
      ? session.inputQuota
      : 4096;

    if (session && typeof session.measureInputUsage === 'function') {
      try {
        const measured = await session.measureInputUsage(singlePassPrompt);
        if (typeof measured === 'number' && measured > 0) {
          inputTokens = measured;
        }
      } catch (_) {}
    }

    const canSinglePass =
      inputTokens <= Math.floor(inputQuota * 0.70) && fullTranscript.length <= 12000;

    if (canSinglePass) {
      await onProgress(42, 'Analyzing transcript on-device...');
      try {
        const minutesText = await promptNanoStreaming(session, singlePassPrompt, (partial) => {
          const ratio = Math.min(1, partial.length / 1500);
          const pct = 45 + Math.round(ratio * 49);
          onProgress(pct, 'Drafting meeting notes...');
        });
        if (minutesText && minutesText.trim()) {
          return minutesText;
        }
      } catch (singleErr) {
        if (!singleErr || singleErr.name !== 'QuotaExceededError') {
          throw singleErr;
        }
      }
    }

    // Multi-chunk map-reduce for longer meetings
    if (session && typeof session.destroy === 'function') {
      try {
        session.destroy();
      } catch (_) {}
      session = null;
    }

    const chunks = splitTranscriptIntoChunks(lines, 6500);
    const chunkSummaries = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkStartPct = 36 + Math.round((i / chunks.length) * 36);
      const chunkEndPct = 36 + Math.round(((i + 1) / chunks.length) * 36);
      await onProgress(
        chunkStartPct,
        `Summarizing transcript part ${i + 1} of ${chunks.length}...`
      );

      let chunkSession = null;
      try {
        chunkSession = await createNanoSession(lm, NANO_SYSTEM_PROMPT);
        const chunkPrompt = `Extract concise bullet points from part ${i + 1} of ${chunks.length} of this meeting transcript. Include:
- Speakers/attendees mentioned (and company if stated)
- Key topics and points discussed
- Any decisions made
- Any action items (owner and deadline if stated)
- Any unresolved follow-ups

Transcript Part ${i + 1}:
${chunks[i]}`;
        const summary = await promptNanoStreaming(chunkSession, chunkPrompt, (partial) => {
          const ratio = Math.min(1, partial.length / 700);
          const pct = chunkStartPct + Math.round(ratio * (chunkEndPct - chunkStartPct));
          onProgress(pct, `Summarizing transcript part ${i + 1} of ${chunks.length}...`);
        });
        chunkSummaries.push(`### Segment ${i + 1}\n${summary.trim()}`);
      } finally {
        if (chunkSession && typeof chunkSession.destroy === 'function') {
          try {
            chunkSession.destroy();
          } catch (_) {}
        }
      }
    }

    await onProgress(74, 'Synthesizing final meeting notes...');
    let synthSession = null;
    try {
      synthSession = await createNanoSession(lm, NANO_SYSTEM_PROMPT);
      const finalPrompt = buildMinutesPrompt(chunkSummaries.join('\n\n'), dateFormatted, true);
      const finalMinutes = await promptNanoStreaming(synthSession, finalPrompt, (partial) => {
        const ratio = Math.min(1, partial.length / 1500);
        const pct = 76 + Math.round(ratio * 18);
        onProgress(pct, 'Drafting final meeting notes...');
      });
      if (!finalMinutes || !finalMinutes.trim()) {
        throw new Error('Empty response from Gemini Nano (On-Device).');
      }
      return finalMinutes;
    } finally {
      if (synthSession && typeof synthSession.destroy === 'function') {
        try {
          synthSession.destroy();
        } catch (_) {}
      }
    }
  } finally {
    if (session && typeof session.destroy === 'function') {
      try {
        session.destroy();
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

  // Keep MV3 service worker alive while waiting on local or cloud generation
  const keepAliveInterval = setInterval(() => {
    chrome.storage.local.get(['notesStatus'], () => {});
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
      const msg = 'Please choose Gemini Nano (On-Device) or Google AI Studio API Key in Settings first.';
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
    const isNanoModel = effectiveMode === 'nano';

    if (!isNanoModel && !apiKey) {
      const msg = 'API key missing. Enter a Google AI Studio API key or choose Gemini Nano (On-Device) in Settings.';
      if (!isHistoryRegen) {
        await chrome.storage.local.set({
          notesStatus: 'error',
          notesError: msg,
          notesErrorCode: ''
        });
      }
      return { status: "error", error: msg };
    }

    const model = isNanoModel ? GEMINI_NANO_MODEL_ID : await resolveActiveModel(apiKey, result);

    let savedEntry = null;
    const nowTs = Date.now();
    if (!isHistoryRegen) {
      savedEntry = await saveToRecentMeetings(lines, result.meetingTitle, result.startTime);
      await chrome.storage.local.set({
        notesStatus: 'generating',
        notesError: '',
        notesErrorCode: '',
        notesProgress: 5,
        notesStage: isNanoModel
          ? 'Preparing Gemini Nano (On-Device)...'
          : 'Connecting to Gemini...',
        generationStartedAt: nowTs,
        generationHeartbeatAt: nowTs
      });
    } else {
      await reportProgress(
        5,
        isNanoModel ? 'Preparing Gemini Nano (On-Device)...' : 'Connecting to Gemini...',
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

    if (isNanoModel) {
      const simMode = result.devNanoSimMode || 'real';
      minutesText = await generateNotesWithGeminiNano(lines, dateFormatted, simMode, (pct, stage) =>
        reportProgress(pct, stage, false)
      );
    } else {
      const fullTranscript = lines.join('\n');
      const prompt = buildMinutesPrompt(fullTranscript, dateFormatted, false);
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
    await reportProgress(100, 'Completed', true);

    if (isHistoryRegen) {
      await updateRecentMeetingTitle(overrideMeeting.id, chosenTitle);
    } else {
      await updateRecentMeetingTitle(savedEntry ? savedEntry.id : result.startTime, chosenTitle);
      await chrome.storage.local.set({
        notesStatus: 'done',
        notesError: '',
        notesErrorCode: '',
        notesProgress: 100,
        notesStage: 'Completed',
        completionUnseen: true
      });
    }

    return { status: "done", filename };
  } catch (error) {
    console.error("mast: Generation failed:", error);
    const errCode = error && error.code === 'NANO_UNAVAILABLE' ? 'nano_unavailable' : '';
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
        notesProgress: 0,
        notesStage: ''
      });
    }
    return { status: "error", error: error.message, errorCode: errCode };
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

  if (chosenMode === 'nano') {
    await chrome.storage.local.set({
      aiMode: 'nano',
      selectedModel: GEMINI_NANO_MODEL_ID,
      modelSelectVal: GEMINI_NANO_MODEL_ID,
      userSelectedModel: true,
      onboardingCompleted: true
    });
    stored.aiMode = 'nano';
    stored.selectedModel = GEMINI_NANO_MODEL_ID;
    stored.modelSelectVal = GEMINI_NANO_MODEL_ID;
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

  if (effectiveMode === 'nano') {
    const nanoAvail = await checkGeminiNanoAvailability(stored.devNanoSimMode || null);
    if (nanoAvail.status === 'unavailable') {
      chrome.runtime.openOptionsPage();
      return { status: "nano_unavailable" };
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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "get_worker_version") {
    sendResponse({ version: WORKER_BUILD_VERSION });
    return false;
  } else if (request.action === "get_nano_availability") {
    checkGeminiNanoAvailability(request.simMode || null).then(sendResponse);
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
