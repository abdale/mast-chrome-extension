const viewApiKey = document.getElementById('view-api-key');
const viewCaptions = document.getElementById('view-captions');
const viewMain = document.getElementById('view-main');
const viewResults = document.getElementById('view-results');

const apiKeyInput = document.getElementById('apiKeyInput');
const validateBtn = document.getElementById('validateBtn');
const apiError = document.getElementById('apiError');

const startBtn = document.getElementById('startBtn');
const magicBtn = document.getElementById('magicBtn');
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

async function validateApiKey(key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite?key=${key}`;
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
  
  const isValid = await validateApiKey(key);
  if (isValid) {
    chrome.storage.local.set({ apiKey: key }, () => {
      updateUI();
    });
  } else {
    apiError.innerText = "Invalid API Key. Please try again.";
    apiError.style.display = "block";
    validateBtn.innerText = "Save & Validate";
    validateBtn.disabled = false;
  }
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
        return !!document.querySelector('[data-tid="closed-captions-container"], [data-tid="closed-caption-text"], [data-tid="author"]');
      }
    });
    return results && results.some(r => r.result === true);
  } catch (e) {
    return false;
  }
}

function updateUI() {
  chrome.storage.local.get(['apiKey', 'isTranscribing', 'savedTranscript', 'startTime', 'issueDetected', 'activeTabId'], async (result) => {
    
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
    statusEl.innerText = "Ready to start.";
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
    magicBtn.innerText = "Attempting...";
    magicBtn.disabled = true;
    executeInActiveTab("force_captions");
    
    let attempts = 0;
    const checkInterval = setInterval(async () => {
       attempts++;
       const captionsOn = await checkCaptions();
       if (captionsOn) {
          clearInterval(checkInterval);
          magicBtn.innerText = "Success! Starting...";
          setTimeout(() => {
             startBtn.click();
          }, 1000);
       } else if (attempts >= 6) { // 3 seconds total (500ms * 6)
          clearInterval(checkInterval);
          magicBtn.innerText = "Auto-Enable failed";
          setTimeout(() => {
             magicBtn.innerText = "Auto-Enable Captions";
             magicBtn.disabled = false;
          }, 3000);
       }
    }, 500);
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
    chrome.downloads.download({ url: url, filename: `Transcript_${Date.now()}.txt`, saveAs: true });
  });
});

generateBtn.addEventListener('click', async () => {
  resultsStatus.style.color = "#333";
  resultsStatus.innerText = "Generating AI Summary...";
  generateBtn.disabled = true;
  generateBtn.innerText = "Generating...";
  
  chrome.storage.local.get(['savedTranscript', 'apiKey'], async (result) => {
    const apiKey = result.apiKey;
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

    const prompt = `You are an expert executive assistant. Generate professional, comprehensive meeting minutes from the provided transcript.
Do NOT use Markdown formatting (no asterisks, no hashes, etc.). Use raw plain text only.

FORMAT REQUIREMENTS:
- Meeting Title: Create a descriptive title for the meeting at the very top.
- Date and Time: ${dateFormatted}
- Attendees: List all attendees based on the transcript. Make a strong effort to deduce and include the company they work for next to their name (e.g., John Smith (Google)).
- Meeting Summary: A detailed summary of the discussion. Explicitly mention attendee names when attributing points so we do not lose track of who said what.
- Key Decisions: Clear decisions made, referencing the people involved.
- Action Items: Clear tasks. You MUST attribute every action item to a specific attendee by name.

Transcript:
${fullTranscript}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
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
      
      const blob = new Blob([minutesText], { type: 'text/plain' });
      const objUrl = URL.createObjectURL(blob);
      chrome.downloads.download({ url: objUrl, filename: `Meeting_AI_Summary_${Date.now()}.txt`, saveAs: true });
      
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
