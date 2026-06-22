// Point this to your deployed Cloud Function URL
const CLOUD_FUNCTION_URL = 'https://us-central1-YOUR-PROJECT-ID.cloudfunctions.net/generate-teams-minutes';

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const generateBtn = document.getElementById('generateBtn');
const statusEl = document.getElementById('status');

// Initialize UI state based on storage
chrome.storage.local.get(['isTranscribing', 'savedTranscript'], (result) => {
  if (result.isTranscribing) {
    startBtn.disabled = true;
    stopBtn.disabled = false;
    generateBtn.disabled = false;
    statusEl.innerText = "Transcribing in progress...";
  } else if (result.savedTranscript && result.savedTranscript.length > 0) {
    startBtn.disabled = false;
    stopBtn.disabled = true;
    generateBtn.disabled = false;
    statusEl.innerText = "Transcript ready for processing.";
  }
});

async function executeInActiveTab(action) {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content.js']
  }, () => {
    chrome.tabs.sendMessage(tab.id, { action: action });
  });
}

startBtn.addEventListener('click', () => {
  chrome.storage.local.set({ savedTranscript: [], isTranscribing: true });
  executeInActiveTab("start");
  
  startBtn.disabled = true;
  stopBtn.disabled = false;
  generateBtn.disabled = false;
  statusEl.innerText = "Listening to captions...";
});

stopBtn.addEventListener('click', () => {
  chrome.storage.local.set({ savedTranscript: [], isTranscribing: false });
  executeInActiveTab("stop");

  startBtn.disabled = false;
  stopBtn.disabled = true;
  generateBtn.disabled = true;
  statusEl.innerText = "Transcribing stopped and slate cleared.";
});

generateBtn.addEventListener('click', async () => {
  statusEl.innerText = "Processing transcript...";
  startBtn.disabled = true;
  stopBtn.disabled = true;
  generateBtn.disabled = true;
  
  // Implicitly stop transcribing but keep the transcript to generate minutes
  chrome.storage.local.set({ isTranscribing: false });
  executeInActiveTab("stop");
  
  chrome.storage.local.get(['savedTranscript'], async (result) => {
    const lines = result.savedTranscript || [];
    if (lines.length === 0) {
      statusEl.innerText = "Error: No captions captured.";
      startBtn.disabled = false;
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
      
      statusEl.innerText = "Success! File downloaded.";
      startBtn.disabled = false;
    } catch (error) {
      statusEl.innerText = "Error generating minutes.";
      startBtn.disabled = false;
      generateBtn.disabled = false;
    }
  });
});
