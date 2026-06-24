const CLOUD_FUNCTION_URL = 'https://us-central1-mythic-plexus-492814-u8.cloudfunctions.net/generate-teams-minutes';

const startBtn = document.getElementById('startBtn');
const stopLink = document.getElementById('stopLink');
const generateBtn = document.getElementById('generateBtn');
const statusEl = document.getElementById('status');
const timerEl = document.getElementById('timer');
const downloadLink = document.getElementById('downloadLink');

let timerInterval = null;
let pollInterval = null;

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
  chrome.storage.local.get(['isTranscribing', 'savedTranscript', 'startTime'], async (result) => {
    const hasTranscript = result.savedTranscript && result.savedTranscript.length > 0;
    
    if (result.isTranscribing) {
      startBtn.disabled = true;
      stopLink.style.display = "block";
      generateBtn.disabled = true;
      downloadLink.style.display = "none";
      if (!statusEl.innerText.includes("Gathering")) statusEl.innerText = "Transcribing in progress...";
      
      const startTime = result.startTime || Date.now();
      startTimer(startTime);
    } else {
      stopLink.style.display = "none";
      stopTimer();
      
      if (hasTranscript) {
        generateBtn.disabled = false;
        downloadLink.style.display = "inline";
      } else {
        generateBtn.disabled = true;
        downloadLink.style.display = "none";
      }
      
      const captionsOn = await checkCaptions();
      if (captionsOn) {
        startBtn.disabled = false;
        if (!hasTranscript && !statusEl.innerText.includes("Error") && !statusEl.innerText.includes("Success")) {
          statusEl.innerText = "Captions detected. Ready to start.";
        }
      } else {
        startBtn.disabled = true;
        if (!hasTranscript && !statusEl.innerText.includes("Error") && !statusEl.innerText.includes("Success")) {
          statusEl.innerText = "Please turn on Live Captions.";
        }
      }
    }
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

startBtn.addEventListener('click', () => {
  const startTime = Date.now();
  chrome.storage.local.set({ savedTranscript: [], isTranscribing: true, startTime: startTime });
  executeInActiveTab("start");
  updateUI();
});

stopLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.storage.local.set({ isTranscribing: false });
  executeInActiveTab("stop");
  updateUI();
  statusEl.innerText = "Transcribing stopped.";
});

downloadLink.addEventListener('click', (e) => {
  e.preventDefault();
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
  statusEl.innerText = "Gathering final captions...";
  startBtn.disabled = true;
  stopLink.style.display = "none";
  generateBtn.disabled = true;
  downloadLink.style.display = "none";
  
  setTimeout(() => {
    chrome.storage.local.set({ isTranscribing: false });
    executeInActiveTab("stop");
    
    chrome.storage.local.get(['savedTranscript'], async (result) => {
      const lines = result.savedTranscript || [];
      if (lines.length === 0) {
        statusEl.innerText = "Error: No captions captured.";
        updateUI();
        return;
      }

      const fullTranscript = lines.join('\n');
      statusEl.innerText = "Generating minutes securely...";

      try {
        const response = await fetch(CLOUD_FUNCTION_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transcript: fullTranscript })
        });

        if (!response.ok) throw new Error("Cloud Function Error");
        
        const data = await response.json();
        
        const blob = new Blob([data.minutes], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        chrome.downloads.download({ url: url, filename: `Meeting_Minutes_${Date.now()}.txt`, saveAs: true });
        
        statusEl.innerText = "Success! Minutes generated.";
        updateUI();
      } catch (error) {
        console.error("Generation failed:", error);
        statusEl.innerText = "Error generating minutes.";
        updateUI();
      }
    });
  }, 3000);
});
