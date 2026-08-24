const viewApiKey = document.getElementById('view-api-key');
const viewCaptions = document.getElementById('view-captions');
const viewMain = document.getElementById('view-main');
const viewResults = document.getElementById('view-results');

const apiKeyInput = document.getElementById('apiKeyInput');
const validateBtn = document.getElementById('validateBtn');
const apiError = document.getElementById('apiError');
const activeModelDisplay = document.getElementById('activeModelDisplay');

const startBtn = document.getElementById('startBtn');
const magicBtn = document.getElementById('magicBtn');
const manualFallbackText = document.getElementById('manualFallbackText');
const issueBanner = document.getElementById('issueBanner');
const stopLink = document.getElementById('stopLink');
const statusEl = document.getElementById('status');
const timerEl = document.getElementById('timer');
const settingsLink = document.getElementById('settingsLink');

const generateBtn = document.getElementById('generateBtn');
const downloadBtn = document.getElementById('downloadBtn');
const newSessionBtn = document.getElementById('newSessionBtn');
const resultsStatus = document.getElementById('resultsStatus');

let timerInterval = null;
let pollInterval = null;

settingsLink.addEventListener('click', (e) => {
  e.preventDefault();
  window.open(chrome.runtime.getURL('options.html'));
});

async function validateApiKey(key, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}?key=${key}`;
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
    apiError.innerText = "Key cannot be empty.";
    apiError.style.display = "block";
    return;
  }
  
  validateBtn.innerText = "Validating...";
  validateBtn.disabled = true;
  apiError.style.display = "none";
  
  chrome.storage.local.get(['selectedModel'], async (result) => {
    const model = result.selectedModel || 'gemini-2.5-flash';
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

function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function updateTimerDisplay(startTime) {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  timerEl.innerText = formatTime(elapsed);
}

function startTimer(startTime) {
  timerEl.style.display = "block";
  updateTimerDisplay(startTime);
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    updateTimerDisplay(startTime);
  }, 1000);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerEl.style.display = "none";
  timerEl.innerText = "00:00";
}

async function checkCaptions() {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return false;
  try {
    let results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        return !!document.querySelector('[data-tid="closed-captions-container"], [data-tid="closed-caption-text"], [data-tid="author"], [aria-label*="caption" i], .ui-captions-container');
      }
    });
    return results && results.some(r => r.result === true);
  } catch (e) {
    return false;
  }
}

function updateUI() {
  chrome.storage.local.get(['apiKey', 'isTranscribing', 'savedTranscript', 'startTime', 'issueDetected', 'activeTabId', 'selectedModel'], async (result) => {
    const model = result.selectedModel || 'gemini-2.5-flash-lite';
    if (activeModelDisplay) {
      if (!result.apiKey) {
        activeModelDisplay.style.display = 'none';
      } else {
        activeModelDisplay.style.display = 'block';
        activeModelDisplay.innerText = `Model: ${model.replace('-latest', '')}`;
      }
    }
    
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let currentTabId = tab ? tab.id : null;
    
    if (result.savedTranscript && result.savedTranscript.length > 0 && result.activeTabId && result.activeTabId !== currentTabId) {
       chrome.storage.local.set({ savedTranscript: [], isTranscribing: false });
       result.savedTranscript = [];
       result.isTranscribing = false;
    }

    // 1. API Key View
    if (!result.apiKey) {
      viewApiKey.style.display = "block";
      viewCaptions.style.display = "none";
      viewMain.style.display = "none";
      viewResults.style.display = "none";
      validateBtn.innerText = "Save & Validate";
      validateBtn.disabled = false;
      return;
    }

    const hasTranscript = result.savedTranscript && result.savedTranscript.length > 0;

    // 2. Transcribing in progress always shows Main View
    if (result.isTranscribing) {
      viewApiKey.style.display = "none";
      viewCaptions.style.display = "none";
      viewMain.style.display = "block";
      viewResults.style.display = "none";
      
      if (result.issueDetected) {
         issueBanner.style.display = "block";
      } else {
         issueBanner.style.display = "none";
      }

      startBtn.disabled = true;
      stopLink.style.display = "block";
      statusEl.innerText = "Transcribing in progress...";
      
      const startTime = result.startTime || Date.now();
      startTimer(startTime);
      return;
    }
    
    // 3. Results View: if not transcribing but we have a transcript
    if (!result.isTranscribing && hasTranscript) {
      viewApiKey.style.display = "none";
      viewCaptions.style.display = "none";
      viewMain.style.display = "none";
      viewResults.style.display = "block";
      stopTimer();
      return;
    }

    // 4. Captions Check View
    const captionsOn = await checkCaptions();
    
    if (!captionsOn) {
      viewApiKey.style.display = "none";
      viewCaptions.style.display = "block";
      viewMain.style.display = "none";
      viewResults.style.display = "none";
      return;
    }
    
    // 5. Main View (Ready to Start)
    viewApiKey.style.display = "none";
    viewCaptions.style.display = "none";
    viewMain.style.display = "block";
    viewResults.style.display = "none";
    
    issueBanner.style.display = "none";
    stopLink.style.display = "none";
    stopTimer();
    
    startBtn.disabled = false;
    statusEl.innerHTML = "Ready to start.<br><span style='font-size: 10px; color: #666; display: inline-block; margin-top: 6px; line-height: 1.2;'>By starting, you confirm you have permission from all attendees to transcribe this session.</span>";
  });
}

updateUI();
pollInterval = setInterval(updateUI, 2000);

async function executeInActiveTab(action) {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    files: ['content.js']
  }, () => {
    chrome.tabs.sendMessage(tab.id, { action: action });
  });
}

if (magicBtn) {
  magicBtn.addEventListener('click', () => {
    magicBtn.style.display = "none";
    executeInActiveTab("force_captions");
    
    setTimeout(() => {
       if (manualFallbackText) {
         manualFallbackText.style.display = "block";
       }
    }, 5000);
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
  chrome.storage.local.get(['savedTranscript', 'meetingTitle'], (result) => {
    const lines = result.savedTranscript || [];
    if (lines.length === 0) return;
    const fullTranscript = lines.join('\n');
    const blob = new Blob([fullTranscript], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const dateStr = new Date().toISOString().split('T')[0];
    const title = result.meetingTitle || "meeting";
    chrome.downloads.download({ url: url, filename: `transcript_${title}_${dateStr}.txt`, saveAs: false });
  });
});

generateBtn.addEventListener('click', async () => {
  resultsStatus.style.color = "#333";
  resultsStatus.innerText = "Generating AI Summary...";
  generateBtn.disabled = true;
  generateBtn.innerText = "Generating...";
  
  chrome.storage.local.get(['savedTranscript', 'apiKey', 'selectedModel'], async (result) => {
    const apiKey = result.apiKey;
    const model = result.selectedModel || 'gemini-2.5-flash-lite';
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

1.  **Meeting Title:** Add a brief, concise title for the meeting based on what is inferred from the transcript summary. Keep this title under 5 words.
2.  **Date, time, and attendees:** Extract and present the date, time, and attendees. The companies of the attendees must be mentioned. This section must consist of exactly two bullet points following this format:
    *   [Date], at [Time] The time is the time showing in the transcript.
    *   Attendees: [Name] ([Company]), [Name] ([Company]). Company may not be obvious, identify from transcript. If it is not clearly identifiable, do not mention company name. Leave it blank.
3.  **Meeting purpose:** Clearly state the goal of the meeting to provide context.
4.  **Agenda items:** Break the minutes into sections that match the meeting's agenda to ensure scannability.
5.  **Key discussions:** Capture the key points discussed concisely. Do not capture every word. (e.g., "Team discussed marketing budget concerns. Decision deferred until Q2.")
6.  **Decisions made:** Clearly state any decisions that were made. You must **bold these decisions** so they are easy to spot.
7.  **Action items:** Identify who is responsible for what action and by when. Write these items clearly. (e.g., "John – finalize vendor contract by March 15.")
8.  **Follow-ups:** Note any unresolved issues or topics that were deferred to future meetings.

Note: The meeting took place on ${dateFormatted}.

Transcript:
${fullTranscript}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
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
      const minutesText = data.candidates[0].content.parts[0].text;
      
      // Extract title from output for filename
      let title = "meeting";
      const linesArr = minutesText.split('\n');
      for (let l of linesArr) {
        if (l.toLowerCase().includes('meeting title:')) {
          title = l.split(/:/)[1].trim();
          break;
        }
      }
      
      // Strip markdown asterisks and hash tags from extracted title
      title = title.replace(/[\*#]/g, '').trim();

      if (title === "meeting" || !title) {
        const firstLine = linesArr.find(l => l.trim().length > 0);
        if (firstLine) title = firstLine.replace(/[\*#]/g, '').trim();
      }
      
      // Sanitize title to lowercase with underscore
      let sanitizedTitle = title.toLowerCase()
        .replace(/[^a-z0-9\s_-]/g, '')
        .trim()
        .replace(/[\s-]+/g, '_')
        .substring(0, 50);
      
      if (!sanitizedTitle) sanitizedTitle = "meeting";
      
      // Save meeting title for transcript downloads
      chrome.storage.local.set({ meetingTitle: sanitizedTitle });
      
      const dateStr = new Date().toISOString().split('T')[0];
      const filename = `summary_${sanitizedTitle}_${dateStr}.md`;

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
      resultsStatus.innerText = "Error: " + error.message; // Full error without 30 char limit
      generateBtn.disabled = false;
      generateBtn.innerText = "Retry Generating";
    }
  });
});
