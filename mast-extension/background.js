// Background Service Worker for mast (Teams AI Minutes)

let isProcessingSession = false;

const BACKGROUND_FALLBACK_MODELS = [
  'gemini-3.0-flash',
  'gemini-3.0-pro',
  'gemini-3.1-flash',
  'gemini-3.1-pro',
  'gemini-2.5-flash'
];

async function callGemini(modelId, apiKey, prompt) {
  const clean = modelId.trim().replace(/^models\//, '');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${clean}:generateContent?key=${apiKey.trim()}`;
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
    const errorData = await response.json().catch(() => ({}));
    const err = new Error(errorData.error?.message || `API error (status ${response.status})`);
    err.status = response.status;
    throw err;
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("No generated text candidate returned from Gemini API");
  }
  return text;
}

async function handleAutoFinalizeSession(request) {
  if (isProcessingSession) {
    return { status: "already_processing" };
  }
  isProcessingSession = true;

  try {
    // 1. Fetch current session data from storage
    const storage = await new Promise(resolve => {
      chrome.storage.local.get([
        'savedTranscript',
        'apiKey',
        'selectedModel',
        'cachedModels',
        'autoDownloadSummary',
        'autoDownloadTranscript'
      ], resolve);
    });

    const lines = storage.savedTranscript || [];
    if (lines.length === 0) {
      chrome.storage.local.set({ isTranscribing: false, activeTabId: null });
      return { status: "no_transcript", message: "No captions were captured in this session." };
    }

    // Set transcribing to false immediately
    await new Promise(resolve => {
      chrome.storage.local.set({ isTranscribing: false, activeTabId: null }, resolve);
    });

    const fullTranscript = lines.join('\n');
    const d = new Date();
    const dateStr = d.toISOString().split('T')[0];
    const timeStr = d.toTimeString().split(' ')[0].replace(/:/g, '-');

    let transcriptDownloaded = false;
    let summaryDownloaded = false;
    let summaryError = null;
    let usedModel = null;
    let retriedWithSecondary = false;

    // 2. Download Raw Transcript if enabled (default true)
    const shouldDownloadTranscript = storage.autoDownloadTranscript !== false;
    if (shouldDownloadTranscript) {
      try {
        const transcriptDataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(fullTranscript);
        await new Promise((resolve) => {
          chrome.downloads.download({
            url: transcriptDataUrl,
            filename: `transcript_${dateStr}_${timeStr}.txt`,
            saveAs: false
          }, () => resolve());
        });
        transcriptDownloaded = true;
      } catch (err) {
        console.warn("mast: Failed to download raw transcript:", err);
      }
    }

    // 3. Generate & Download AI Summary if enabled (default true)
    const shouldDownloadSummary = storage.autoDownloadSummary !== false;
    const apiKey = storage.apiKey;

    if (shouldDownloadSummary && apiKey) {
      // Determine primary and secondary models
      const modelPool = (storage.cachedModels && storage.cachedModels.length > 0)
        ? storage.cachedModels.map(m => m.id)
        : BACKGROUND_FALLBACK_MODELS;

      let primaryModel = storage.selectedModel || modelPool[0] || 'gemini-3.0-flash';
      let secondaryModel = modelPool.find(m => m !== primaryModel) ||
        BACKGROUND_FALLBACK_MODELS.find(m => m !== primaryModel) ||
        'gemini-3.0-pro';

      const dateObj = new Date();
      const dateFormatted = dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) + ' at ' + dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';

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

      let minutesText = null;

      try {
        console.log(`mast: Attempting AI summary with primary model: ${primaryModel}`);
        minutesText = await callGemini(primaryModel, apiKey, prompt);
        usedModel = primaryModel;
      } catch (err) {
        console.warn(`mast: Primary model (${primaryModel}) failed: ${err.message}.`);
        // If primary model failed (429 rate limit or any error), retry with secondary model
        if (secondaryModel && secondaryModel !== primaryModel) {
          try {
            console.log(`mast: Retrying AI summary with secondary model: ${secondaryModel}`);
            minutesText = await callGemini(secondaryModel, apiKey, prompt);
            usedModel = secondaryModel;
            retriedWithSecondary = true;
          } catch (retryErr) {
            console.error(`mast: Secondary model (${secondaryModel}) also failed:`, retryErr);
            summaryError = retryErr.message;
          }
        } else {
          summaryError = err.message;
        }
      }

      if (minutesText) {
        let aiTitle = "meeting";
        const outLines = minutesText.split('\n');
        for (let i = 0; i < outLines.length; i++) {
          if (outLines[i].toLowerCase().includes('# title') && i + 1 < outLines.length) {
            aiTitle = outLines[i+1].trim();
            if (!aiTitle && i + 2 < outLines.length) {
              aiTitle = outLines[i+2].trim();
            }
            break;
          }
        }

        let sanitizedTitle = aiTitle.toLowerCase()
          .replace(/[^a-z0-9\s_-]/g, '')
          .trim()
          .replace(/[\s-]+/g, '_')
          .substring(0, 50);

        if (!sanitizedTitle || sanitizedTitle === 'title') sanitizedTitle = "meeting";

        const mdFilename = `ai_summary_${sanitizedTitle}_${dateStr}_${timeStr}.md`;
        const mdDataUrl = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(minutesText);

        await new Promise((resolve) => {
          chrome.downloads.download({
            url: mdDataUrl,
            filename: mdFilename,
            saveAs: false
          }, () => resolve());
        });
        summaryDownloaded = true;
      }
    } else if (shouldDownloadSummary && !apiKey) {
      summaryError = "Missing API key in settings";
    }

    return {
      status: "success",
      transcriptDownloaded,
      summaryDownloaded,
      summaryError,
      usedModel,
      retriedWithSecondary
    };
  } catch (globalErr) {
    console.error("mast: Error in handleAutoFinalizeSession:", globalErr);
    return { status: "error", message: globalErr.message };
  } finally {
    isProcessingSession = false;
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "auto_finalize_session") {
    handleAutoFinalizeSession(request).then(sendResponse);
    return true; // Keep message port open for async response
  }

  if (request.action === "meeting_started" || request.action === "open_popup") {
    if (chrome.action && typeof chrome.action.openPopup === 'function') {
      const windowId = sender?.tab?.windowId;
      chrome.action.openPopup(windowId ? { windowId } : {})
        .then(() => {
          sendResponse({ status: "popup_opened" });
        })
        .catch((err) => {
          // In some Chrome versions, openPopup without user gesture is blocked by browser policy
          console.log("mast: Could not auto-open extension action popup:", err.message);
          sendResponse({ status: "popup_not_opened", error: err.message });
        });
      return true; // Keep message channel open for async response
    } else {
      sendResponse({ status: "openPopup_not_available" });
    }
  }
});
