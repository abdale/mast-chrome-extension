// Background Service Worker for mast (Meeting AI Summarizer & Transcriber for MS Teams)

let isGeneratingInMemory = false;

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

async function resolveActiveModel(apiKey, storedState) {
  if (storedState.modelSelectVal === 'custom' && storedState.customModelVal) {
    return storedState.customModelVal.trim().replace(/^models\//, '');
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (response.ok) {
      const data = await response.json();
      const topFlash = getTopStableFlashModels(data.models);
      const validIds = topFlash.map(m => m.name.replace('models/', ''));

      if (validIds.length > 0) {
        if (storedState.selectedModel && validIds.includes(storedState.selectedModel)) {
          return storedState.selectedModel;
        }
        const latestFlashId = validIds[0];
        await chrome.storage.local.set({
          selectedModel: latestFlashId,
          modelSelectVal: latestFlashId
        });
        return latestFlashId;
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

function getDateAndTimeStrings(dateObj = new Date()) {
  const dateStr = dateObj.toISOString().split('T')[0];
  const timeStr = dateObj.toTimeString().split(' ')[0].replace(/:/g, '-');
  return { dateStr, timeStr };
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

async function downloadTranscriptIfNeeded(forceDownload = false) {
  const result = await chrome.storage.local.get(['savedTranscript', 'transcriptDownloaded']);
  const lines = result.savedTranscript || [];
  if (lines.length === 0) return false;
  if (!forceDownload && result.transcriptDownloaded) return false;

  const fullTranscript = lines.join('\n');
  const { dateStr, timeStr } = getDateAndTimeStrings();
  const filename = `transcript_${dateStr}_${timeStr}.txt`;

  await downloadTextViaDataUrl(fullTranscript, 'text/plain', filename);
  await chrome.storage.local.set({ transcriptDownloaded: true });
  return true;
}

async function generateAndDownloadNotes() {
  if (isGeneratingInMemory) {
    return { status: "already_generating" };
  }
  isGeneratingInMemory = true;

  try {
    const result = await chrome.storage.local.get([
      'savedTranscript',
      'apiKey',
      'selectedModel',
      'modelSelectVal',
      'customModelVal',
      'meetingTitle'
    ]);

    const lines = result.savedTranscript || [];
    if (lines.length === 0) {
      await chrome.storage.local.set({
        notesStatus: 'error',
        notesError: 'No captions captured.'
      });
      return { status: "error", error: "No captions captured." };
    }

    const apiKey = result.apiKey ? result.apiKey.trim() : '';
    if (!apiKey) {
      await chrome.storage.local.set({
        notesStatus: 'error',
        notesError: 'API Key missing.'
      });
      return { status: "error", error: "API Key missing." };
    }

    await chrome.storage.local.set({
      notesStatus: 'generating',
      notesError: ''
    });

    const model = await resolveActiveModel(apiKey, result);
    const fullTranscript = lines.join('\n');

    const dateObj = new Date();
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

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

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

    let sanitizedTitle = aiTitle
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, '')
      .trim()
      .replace(/[\s-]+/g, '_')
      .substring(0, 50);

    if (!sanitizedTitle || sanitizedTitle === 'title') sanitizedTitle = "meeting";

    const { dateStr, timeStr } = getDateAndTimeStrings();
    const filename = `ai_summary_${sanitizedTitle}_${dateStr}_${timeStr}.md`;

    await downloadTextViaDataUrl(minutesText, 'text/markdown', filename);

    await chrome.storage.local.set({
      notesStatus: 'done',
      notesError: ''
    });

    return { status: "done", filename };
  } catch (error) {
    console.error("mast: Generation failed:", error);
    await chrome.storage.local.set({
      notesStatus: 'error',
      notesError: error.message || "Failed to generate AI summary."
    });
    return { status: "error", error: error.message };
  } finally {
    isGeneratingInMemory = false;
  }
}

async function handleSessionEnded() {
  const result = await chrome.storage.local.get(['savedTranscript', 'isTranscribing', 'notesStatus']);
  if (result.isTranscribing) {
    await chrome.storage.local.set({ isTranscribing: false });
  }

  const lines = result.savedTranscript || [];
  if (lines.length === 0) {
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

// Auto-migrate model selection when extension is installed or updated
chrome.runtime.onInstalled.addListener(async () => {
  const result = await chrome.storage.local.get(['apiKey', 'selectedModel', 'modelSelectVal', 'customModelVal']);
  if (result.apiKey) {
    await resolveActiveModel(result.apiKey, result);
  }
});

// Safety net: if the user closes the Teams tab, finalize any active session & clean up state
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const result = await chrome.storage.local.get(['isTranscribing', 'activeTabId', 'savedTranscript', 'notesStatus']);
  if (result.activeTabId === tabId) {
    if (result.isTranscribing) {
      await chrome.storage.local.set({ isTranscribing: false });
      if (result.savedTranscript && result.savedTranscript.length > 0) {
        await handleSessionEnded();
      }
    }
    if (!isGeneratingInMemory) {
      await chrome.storage.local.set({
        savedTranscript: [],
        activeTabId: null,
        notesStatus: 'idle',
        notesError: '',
        transcriptDownloaded: false
      });
    }
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "session_ended") {
    handleSessionEnded().then(sendResponse);
    return true;
  } else if (request.action === "generate_notes") {
    generateAndDownloadNotes().then(sendResponse);
    return true;
  } else if (request.action === "download_transcript") {
    downloadTranscriptIfNeeded(true)
      .then(() => sendResponse({ status: "downloaded" }))
      .catch((err) => sendResponse({ status: "error", error: err.message }));
    return true;
  }
});
