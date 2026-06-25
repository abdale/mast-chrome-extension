const startBtn = document.getElementById('startBtn');
const stopLink = document.getElementById('stopLink');
const generateLink = document.getElementById('generateLink');
const statusEl = document.getElementById('status');
const timerEl = document.getElementById('timer');
const downloadLink = document.getElementById('downloadLink');
const settingsLink = document.getElementById('settingsLink');

let timerInterval = null;
let pollInterval = null;

settingsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
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

function updateUI() {
  chrome.storage.local.get(['isTranscribing', 'savedTranscript', 'startTime'], (result) => {
    const hasTranscript = result.savedTranscript && result.savedTranscript.length > 0;
    
    if (result.isTranscribing) {
      startBtn.disabled = true;
      stopLink.style.display = "block";
      generateLink.style.display = "none";
      downloadLink.style.display = "none";
      if (!statusEl.innerText.includes("Gathering")) statusEl.innerText = "Transcribing in progress...";
      
      const startTime = result.startTime || Date.now();
      startTimer(startTime);
    } else {
      stopLink.style.display = "none";
      stopTimer();
      
      if (hasTranscript) {
        generateLink.style.display = "inline";
        downloadLink.style.display = "inline";
      } else {
        generateLink.style.display = "none";
        downloadLink.style.display = "none";
      }
      
      startBtn.disabled = false;
      if (!hasTranscript && !statusEl.innerText.includes("Error") && !statusEl.innerText.includes("Success")) {
        statusEl.innerText = "Ready to start.";
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

generateLink.addEventListener('click', async (e) => {
  e.preventDefault();
  statusEl.innerText = "Gathering final captions...";
  startBtn.disabled = true;
  stopLink.style.display = "none";
  generateLink.style.display = "none";
  downloadLink.style.display = "none";
  
  setTimeout(() => {
    chrome.storage.local.set({ isTranscribing: false });
    executeInActiveTab("stop");
    
    chrome.storage.local.get(['savedTranscript', 'apiKey'], async (result) => {
      const apiKey = result.apiKey;
      if (!apiKey) {
        statusEl.innerText = "Error: Please add your API Key in Settings (⚙️).";
        updateUI();
        return;
      }
      
      const lines = result.savedTranscript || [];
      if (lines.length === 0) {
        statusEl.innerText = "Error: No captions captured.";
        updateUI();
        return;
      }

      const fullTranscript = lines.join('\n');
      statusEl.innerText = "Generating AI Summary directly...";

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
        
        statusEl.innerText = "Success! Summary generated.";
        updateUI();
      } catch (error) {
        console.error("Generation failed:", error);
        statusEl.innerText = "Error: " + error.message.substring(0, 30);
        updateUI();
      }
    });
  }, 3000);
});
