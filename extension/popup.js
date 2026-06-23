const CLOUD_FUNCTION_URL = 'https://us-central1-mythic-plexus-492814-u8.cloudfunctions.net/generate-teams-minutes';

const startBtn = document.getElementById('startBtn');
const stopLink = document.getElementById('stopLink');
const generateBtn = document.getElementById('generateBtn');
const statusEl = document.getElementById('status');

// Initialize UI state based on storage
chrome.storage.local.get(['isTranscribing', 'savedTranscript'], (result) => {
  if (result.isTranscribing) {
    startBtn.disabled = true;
    stopLink.style.display = "block";
    generateBtn.disabled = false;
    statusEl.innerText = "Transcribing in progress...";
  } else if (result.savedTranscript && result.savedTranscript.length > 0) {
    startBtn.disabled = false;
    stopLink.style.display = "none";
    generateBtn.disabled = false;
    statusEl.innerText = "Transcript ready for processing.";
  }
});

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
  chrome.storage.local.set({ savedTranscript: [], isTranscribing: true });
  executeInActiveTab("start");
  
  startBtn.disabled = true;
  stopLink.style.display = "block";
  generateBtn.disabled = false;
  statusEl.innerText = "Listening to captions...";
});

stopLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.storage.local.set({ savedTranscript: [], isTranscribing: false });
  executeInActiveTab("stop");

  startBtn.disabled = false;
  stopLink.style.display = "none";
  generateBtn.disabled = true;
  statusEl.innerText = "Transcribing stopped and slate cleared.";
});

generateBtn.addEventListener('click', async () => {
  statusEl.innerText = "Waiting 3 seconds for final captions...";
  startBtn.disabled = true;
  stopLink.style.display = "none";
  generateBtn.disabled = true;
  
  setTimeout(() => {
    // Implicitly stop transcribing but keep the transcript to generate minutes
    chrome.storage.local.set({ isTranscribing: false });
    executeInActiveTab("stop");
    
    chrome.storage.local.get(['savedTranscript'], async (result) => {
      const lines = result.savedTranscript || [];
      console.log("Teams AI Minutes: Generate Minutes clicked. Transcript length:", lines.length);

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
        
        statusEl.innerText = "Success! Minutes generated.";
        startBtn.disabled = false;
      } catch (error) {
        console.error("Generation failed:", error);
        statusEl.innerText = "Error generating minutes.";
        startBtn.disabled = false;
        generateBtn.disabled = false;
      }
    });
  }, 3000);
});
