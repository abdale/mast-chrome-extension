const viewApiKey = document.getElementById('view-api-key');
const viewNoMeeting = document.getElementById('view-no-meeting');
const viewCaptions = document.getElementById('view-captions');
const viewMain = document.getElementById('view-main');
const viewResults = document.getElementById('view-results');

const apiKeyInput = document.getElementById('apiKeyInput');
const validateBtn = document.getElementById('validateBtn');
const apiError = document.getElementById('apiError');
const activeModelDisplay = document.getElementById('activeModelDisplay');

const startBtn = document.getElementById('startBtn');
const magicBtn = document.getElementById('magicBtn');
const stopLink = document.getElementById('stopLink');
const downloadBtn = document.getElementById('downloadBtn');
const generateBtn = document.getElementById('generateBtn');
const newSessionBtn = document.getElementById('newSessionBtn');

const timerEl = document.getElementById('timer');
const statusEl = document.getElementById('status');
const resultsStatus = document.getElementById('resultsStatus');
const issueBanner = document.getElementById('issueBanner');
const settingsLink = document.getElementById('settingsLink');
const manualFallbackText = document.getElementById('manualFallbackText');

let timerInterval = null;
let pollInterval = null;

settingsLink.addEventListener('click', (e) => {
  e.preventDefault();
  window.open(chrome.runtime.getURL('options.html'));
});

async function validateApiKey(key, model) {
  const cleanModel = (model || 'gemini-2.5-flash').trim().replace(/^models\//, '');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}?key=${key.trim()}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    return true;
  } catch (e) {
    return false;
  }
}

validateBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    apiError.innerText = "Please enter an API Key.";
    apiError.style.display = "block";
    return;
  }

  validateBtn.innerText = "Validating...";
  validateBtn.disabled = true;
  apiError.style.display = "none";
  
  chrome.storage.local.get(['selectedModel', 'cachedModels'], async (result) => {
    let model = result.selectedModel;
    if (!model && result.cachedModels && result.cachedModels.length > 0) {
      model = result.cachedModels[0].id;
    }
    if (!model) {
      model = 'gemini-2.5-flash';
    }
    const isValid = await validateApiKey(key, model);
    if (isValid) {
      chrome.storage.local.set({ apiKey: key }, () => {
        updateUI();
      });
    } else {
      apiError.innerText = `Invalid API Key or model (${model}) is unavailable. Please try again.`;
      apiError.style.display = "block";
      validateBtn.innerText = "Save & Validate";
      validateBtn.disabled = false;
    }
  });
});

function startTimer(startTime) {
  if (timerInterval) clearInterval(timerInterval);
  timerEl.style.display = "block";
  
  function update() {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const s = (elapsed % 60).toString().padStart(2, '0');
    timerEl.innerText = `${m}:${s}`;
  }
  update();
  timerInterval = setInterval(update, 1000);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  timerEl.style.display = "none";
  timerEl.innerText = "00:00";
}

async function checkActiveMeeting() {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url || (!tab.url.includes("teams.microsoft.com") && !tab.url.includes("teams.live.com"))) {
    return { isTeams: false, inMeeting: false };
  }
  try {
    let results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        const callIndicators = [
          '[data-tid="call-duration"]',
          '#hangup-button',
          'button[data-tid="hangup-button"]',
          'button[data-tid="call-hangup"]',
          'button[aria-label="Leave call" i]',
          'button[aria-label="Leave meeting" i]',
          'button[aria-label="Hang up" i]',
          '[data-tid="calling-top-bar"]',
          '[data-tid="calling-screen"]',
          '[data-tid="meeting-stage"]',
          '[data-tid="calling-stage"]',
          '[data-tid="closed-captions-container"]',
          '[data-tid="closed-caption-renderer-wrapper"]'
        ];
        return callIndicators.some(sel => !!document.querySelector(sel));
      }
    });
    const inMeeting = results && results.some(r => r.result === true);
    return { isTeams: true, inMeeting };
  } catch (e) {
    return { isTeams: true, inMeeting: false };
  }
}

async function checkCaptions() {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return false;
  try {
    let results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        // True caption rendering elements
        const captionElements = document.querySelector(
          '[data-tid="closed-captions-container"], [data-tid="closed-caption-renderer-wrapper"], [data-tid="closed-caption-text"], .ui-captions-container'
        );
        if (captionElements) return true;

        // Button that is already turned on (pressed/checked or labeled 'Turn off')
        const activeToggle = document.querySelector(
          'button[aria-label*="Turn off live captions" i], button[aria-label*="caption" i][aria-pressed="true"], button[aria-label*="caption" i][aria-checked="true"], button[data-tid*="caption"][aria-pressed="true"]'
        );
        return !!activeToggle;
      }
    });
    return results && results.some(r => r.result === true);
  } catch (e) {
    return false;
  }
}

function updateUI() {
  chrome.storage.local.get(['apiKey', 'isTranscribing', 'savedTranscript', 'startTime', 'issueDetected', 'activeTabId', 'selectedModel', 'cachedModels'], async (result) => {
    let model = result.selectedModel;
    if (!model && result.cachedModels && result.cachedModels.length > 0) {
      model = result.cachedModels[0].id;
    }
    if (!model) {
      model = 'gemini-2.5-flash';
    }
    if (activeModelDisplay) {
      activeModelDisplay.innerText = `Model: ${model.replace('-latest', '')}`;
    }
    
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let currentTabId = tab ? tab.id : null;
    
    // Only clear if a live transcription session was active and user switched away from that tab
    if (result.isTranscribing && result.activeTabId && result.activeTabId !== currentTabId) {
       chrome.storage.local.set({ savedTranscript: [], isTranscribing: false, activeTabId: null });
       result.savedTranscript = [];
       result.isTranscribing = false;
       result.activeTabId = null;
    }

    // 1. API Key View
    if (!result.apiKey) {
      viewApiKey.style.display = "block";
      if (viewNoMeeting) viewNoMeeting.style.display = "none";
      viewCaptions.style.display = "none";
      viewMain.style.display = "none";
      viewResults.style.display = "none";
      const viewUpload = document.getElementById('view-upload');
      if (viewUpload) viewUpload.style.display = "none";
      stopTimer();
      return;
    }

    const hasTranscript = result.savedTranscript && result.savedTranscript.length > 0;

    const viewUpload = document.getElementById('view-upload');
    if (viewUpload) {
      if (result.apiKey && !result.isTranscribing && !hasTranscript) {
        viewUpload.style.display = "block";
      } else {
        viewUpload.style.display = "none";
      }
    }

    // 2. Transcribing in progress always shows Main View
    if (result.isTranscribing) {
      viewApiKey.style.display = "none";
      if (viewNoMeeting) viewNoMeeting.style.display = "none";
      viewCaptions.style.display = "none";
      viewMain.style.display = "block";
      viewResults.style.display = "none";

      if (result.issueDetected) {
         issueBanner.style.display = "block";
      } else {
         issueBanner.style.display = "none";
      }

      const promptEl = document.getElementById('mainMeetingPrompt');
      if (promptEl) promptEl.style.display = "none";

      startBtn.disabled = true;
      stopLink.style.display = "block";
      statusEl.innerText = "Transcribing in progress...";
      if (result.startTime) {
        startTimer(result.startTime);
      }
      return;
    }

    // 3. Results View: if not transcribing but we have a transcript
    if (!result.isTranscribing && hasTranscript) {
      viewApiKey.style.display = "none";
      if (viewNoMeeting) viewNoMeeting.style.display = "none";
      viewCaptions.style.display = "none";
      viewMain.style.display = "none";
      viewResults.style.display = "block";
      stopTimer();
      return;
    }

    // 4. Meeting Check: Is the active tab in an active Teams meeting?
    const { inMeeting } = await checkActiveMeeting();

    if (!inMeeting) {
      viewApiKey.style.display = "none";
      if (viewNoMeeting) viewNoMeeting.style.display = "block";
      viewCaptions.style.display = "none";
      viewMain.style.display = "none";
      viewResults.style.display = "none";
      stopTimer();
      return;
    }

    // 5. User IS in an active meeting: Check Captions
    if (viewNoMeeting) viewNoMeeting.style.display = "none";
    const captionsOn = await checkCaptions();
    
    if (!captionsOn) {
      viewApiKey.style.display = "none";
      viewCaptions.style.display = "block";
      viewMain.style.display = "none";
      viewResults.style.display = "none";
      stopTimer();
      return;
    }
    
    // 6. In active meeting AND captions are ON (Ready to Start)
    viewApiKey.style.display = "none";
    viewCaptions.style.display = "none";
    viewMain.style.display = "block";
    viewResults.style.display = "none";

    const promptEl = document.getElementById('mainMeetingPrompt');
    if (promptEl) promptEl.style.display = "block";
    
    issueBanner.style.display = "none";
    stopLink.style.display = "none";
    stopTimer();
    
    startBtn.disabled = false;
    statusEl.innerText = "Ready to start.";
  });
}

updateUI();
pollInterval = setInterval(updateUI, 2000);

async function executeInActiveTab(action) {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { action: action }, (response) => {
    if (chrome.runtime.lastError) {
      // Content script not yet attached to tab; inject content.js and retry
      chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content.js']
      }, () => {
        chrome.tabs.sendMessage(tab.id, { action: action });
      });
    }
  });
}

if (magicBtn) {
  magicBtn.addEventListener('click', () => {
    magicBtn.innerText = "Enabling...";
    magicBtn.disabled = true;
    executeInActiveTab("force_captions");
    
    setTimeout(() => {
      if (manualFallbackText) {
        const platform = (navigator.platform || '').toUpperCase();
        const userAgent = navigator.userAgent || '';
        const isMac = platform.includes('MAC') || userAgent.includes('Macintosh') || userAgent.includes('Mac OS');
        const shortcut = isMac ? "Cmd + Shift + O" : "Alt + Shift + C";
        manualFallbackText.innerHTML = `
          <div style="margin-top: 6px; padding: 6px; background: #ffffff; border-radius: 4px; border: 1px dashed #93c5fd;">
            <div>Shortcut: <b style="color: #1e3a8a;">${shortcut}</b></div>
            <div style="font-size: 10px; color: #6b7280; margin-top: 2px;">or click <b>More (...) &gt; Language &amp; speech &gt; Turn on live captions</b></div>
          </div>
        `;
        manualFallbackText.style.display = "block";
      }
      magicBtn.innerText = "Enable Captions";
      magicBtn.disabled = false;
    }, 1500);
  });
}

startBtn.addEventListener('click', async () => {
  const startTime = Date.now();
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.storage.local.set({ savedTranscript: [], isTranscribing: true, startTime: startTime, issueDetected: false, activeTabId: tab ? tab.id : null });
  executeInActiveTab("start");
  updateUI();
});

stopLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.storage.local.set({ isTranscribing: false });
  executeInActiveTab("stop");
  updateUI();
});

newSessionBtn.addEventListener('click', () => {
  chrome.storage.local.set({ savedTranscript: [] });
  resultsStatus.innerText = "";
  generateBtn.innerText = "Generate AI Summary";
  updateUI();
});

downloadBtn.addEventListener('click', () => {
  chrome.storage.local.get(['savedTranscript'], (result) => {
    const lines = result.savedTranscript || [];
    if (lines.length === 0) return;
    const fullTranscript = lines.join('\n');
    const blob = new Blob([fullTranscript], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const d = new Date();
    const dateStr = d.toISOString().split('T')[0];
    const timeStr = d.toTimeString().split(' ')[0].replace(/:/g, '-');
    chrome.downloads.download({ url: url, filename: `transcript_${dateStr}_${timeStr}.txt`, saveAs: false });
  });
});

generateBtn.addEventListener('click', async () => {
  resultsStatus.style.color = "#333";
  resultsStatus.innerText = "Generating AI Summary...";
  generateBtn.disabled = true;
  generateBtn.innerText = "Generating...";
  
  chrome.storage.local.get(['savedTranscript', 'apiKey', 'selectedModel', 'cachedModels'], async (result) => {
    const apiKey = result.apiKey;
    let model = result.selectedModel;
    if (!model && result.cachedModels && result.cachedModels.length > 0) {
      model = result.cachedModels[0].id;
    }
    if (!model) {
      model = 'gemini-2.5-flash';
    }

    if (!apiKey) {
      resultsStatus.style.color = "red";
      resultsStatus.innerText = "Error: API Key missing.";
      generateBtn.disabled = false;
      generateBtn.innerText = "Retry Generating";
      return;
    }
    
    const lines = result.savedTranscript || [];
    if (lines.length === 0) {
      resultsStatus.style.color = "red";
      resultsStatus.innerText = "Error: No captions captured.";
      generateBtn.disabled = false;
      generateBtn.innerText = "Retry Generating";
      return;
    }

    const fullTranscript = lines.join('\n');

    // Build Date String
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

    const cleanModel = model.trim().replace(/^models\//, '');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${apiKey.trim()}`;
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 }
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || "Google AI Studio Error");
      }
      
      const data = await response.json();
      let minutesText = data.candidates[0].content.parts[0].text;
      
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
      
      const d = new Date();
      const dateStr = d.toISOString().split('T')[0];
      const timeStr = d.toTimeString().split(' ')[0].replace(/:/g, '-');
      const filename = `ai_summary_${sanitizedTitle}_${dateStr}_${timeStr}.md`;

      const blob = new Blob([minutesText], { type: 'text/markdown' });
      const objUrl = URL.createObjectURL(blob);
      chrome.downloads.download({ url: objUrl, filename: filename, saveAs: false });
      
      resultsStatus.style.color = "green";
      resultsStatus.innerText = "Success! Summary downloaded.";
      generateBtn.disabled = false;
      generateBtn.innerText = "Generate AI Summary";
    } catch (error) {
      console.error("Generation failed:", error);
      resultsStatus.style.color = "red";
      resultsStatus.innerText = "Error: " + error.message;
      generateBtn.disabled = false;
      generateBtn.innerText = "Retry Generating";
    }
  });
});

// File Upload Logic
const uploadZone = document.getElementById('view-upload');
const transcriptFileInput = document.getElementById('transcriptFile');

if (uploadZone && transcriptFileInput) {
  uploadZone.addEventListener('click', (e) => {
    if (e.target !== transcriptFileInput) {
      transcriptFileInput.click();
    }
  });

  // Drag and Drop styles
  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.style.backgroundColor = "#f5f6ff";
    uploadZone.style.borderColor = "#464eb8";
  });

  uploadZone.addEventListener('dragleave', () => {
    uploadZone.style.backgroundColor = "#fcfcff";
    uploadZone.style.borderColor = "#5B5FC7";
  });

  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.style.backgroundColor = "#fcfcff";
    uploadZone.style.borderColor = "#5B5FC7";
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleTranscriptFile(e.dataTransfer.files[0]);
    }
  });

  transcriptFileInput.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  transcriptFileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleTranscriptFile(e.target.files[0]);
      e.target.value = '';
    }
  });
}

function handleTranscriptFile(file) {
  if (!file.name.toLowerCase().endsWith('.txt')) {
    alert("Please upload a valid .txt transcript file.");
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
    
    if (lines.length === 0) {
      alert("The uploaded file is empty.");
      return;
    }

    // Set savedTranscript and clear activeTabId and isTranscribing so it's a clean offline session
    chrome.storage.local.set({ savedTranscript: lines, activeTabId: null, isTranscribing: false }, () => {
      updateUI();
      // Auto-trigger AI summary generation immediately
      setTimeout(() => {
        if (generateBtn && !generateBtn.disabled) {
          generateBtn.click();
        }
      }, 150);
    });
  };
  reader.readAsText(file);
}
