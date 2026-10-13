const viewApiKey = document.getElementById('view-api-key');
const viewMain = document.getElementById('view-main');
const viewResults = document.getElementById('view-results');

const apiKeyInput = document.getElementById('apiKeyInput');
const validateBtn = document.getElementById('validateBtn');
const apiError = document.getElementById('apiError');

const startBtn = document.getElementById('startBtn');
const captionHelperText = document.getElementById('captionHelperText');
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

async function validateApiKey(key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return { valid: false, latestFlashModel: null };
    const data = await response.json();
    const topFlash = getTopStableFlashModels(data.models);
    const defaultModel = topFlash.length > 0 ? topFlash[0].name.replace('models/', '') : 'gemini-2.5-flash';

    return { valid: true, latestFlashModel: defaultModel };
  } catch (error) {
    return { valid: false, latestFlashModel: null };
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

  chrome.storage.local.get(['selectedModel', 'modelSelectVal'], async (result) => {
    const validation = await validateApiKey(key);

    if (validation.valid) {
      if (!result.selectedModel || result.modelSelectVal !== 'custom') {
        chrome.storage.local.set({
          selectedModel: validation.latestFlashModel,
          modelSelectVal: validation.latestFlashModel
        });
      }
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

async function checkPageStatus() {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { captionsOn: false, inActiveCall: false, meetingTitle: "Meeting" };
  try {
    let results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        const captionsOn = !!document.querySelector('[data-tid="closed-captions-container"], [data-tid="closed-caption-text"], [data-tid="author"], [aria-label*="caption" i], .ui-captions-container');
        const inActiveCall = captionsOn || !!document.querySelector('[data-tid="call-duration"], #hangup-button, button[data-tid="hangup-button"], button[data-tid="call-hangup"], button[aria-label="Leave call" i], button[aria-label="Leave meeting" i], button[aria-label="Hang up" i], [data-tid="calling-top-bar"], [data-tid="calling-screen"], [data-tid="meeting-stage"], [data-tid="calling-stage"]');
        return { captionsOn: captionsOn, inActiveCall: inActiveCall, meetingTitle: "Meeting" };
      }
    });
    if (!results) return { captionsOn: false, inActiveCall: false, meetingTitle: "Meeting" };

    let captionsOn = false;
    let inActiveCall = false;
    let meetingTitle = "Meeting";

    for (let r of results) {
      if (r.result) {
        if (r.result.captionsOn) captionsOn = true;
        if (r.result.inActiveCall) inActiveCall = true;
        if (r.result.meetingTitle && r.result.meetingTitle !== "Meeting") meetingTitle = r.result.meetingTitle;
      }
    }
    return { captionsOn, inActiveCall, meetingTitle };
  } catch (e) {
    return { captionsOn: false, inActiveCall: false, meetingTitle: "Meeting" };
  }
}

function updateUI() {
  chrome.storage.local.get([
    'apiKey',
    'isTranscribing',
    'savedTranscript',
    'startTime',
    'issueDetected',
    'activeTabId',
    'selectedModel',
    'notesStatus',
    'notesError',
    'callEnded'
  ], async (result) => {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const pageStatus = await checkPageStatus();

    if (pageStatus.meetingTitle && pageStatus.meetingTitle !== "Meeting") {
      chrome.storage.local.set({ meetingTitle: pageStatus.meetingTitle });
    }

    let currentTabId = tab ? tab.id : null;
    const switchedToNewTab = !!(result.activeTabId && result.activeTabId !== currentTabId);
    const startedNewCallInSameTab = !!(result.callEnded && pageStatus.inActiveCall && !result.isTranscribing);

    if (
      result.savedTranscript &&
      result.savedTranscript.length > 0 &&
      (switchedToNewTab || startedNewCallInSameTab) &&
      result.notesStatus !== 'generating'
    ) {
      chrome.storage.local.set({
        savedTranscript: [],
        isTranscribing: false,
        notesStatus: 'idle',
        notesError: '',
        transcriptDownloaded: false,
        callEnded: false
      });
      result.savedTranscript = [];
      result.isTranscribing = false;
      result.notesStatus = 'idle';
      result.notesError = '';
      result.callEnded = false;
    }

    // 1. API Key View
    if (!result.apiKey) {
      viewApiKey.style.display = "block";
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

      if (captionHelperText) {
        if (!pageStatus.captionsOn && !hasTranscript && Date.now() - startTime >= 5000) {
          captionHelperText.style.display = "block";
          captionHelperText.innerText = "Did captions turn on? Press Alt + Shift + C to toggle manually.";
        } else {
          captionHelperText.style.display = "none";
        }
      }
      return;
    }

    // 3. Results View: if not transcribing but we have a transcript
    if (!result.isTranscribing && hasTranscript) {
      viewApiKey.style.display = "none";
      viewMain.style.display = "none";
      viewResults.style.display = "block";
      stopTimer();

      if (result.notesStatus === 'generating') {
        generateBtn.disabled = true;
        generateBtn.innerText = "Generating...";
        resultsStatus.style.color = "#333";
        resultsStatus.innerText = "Generating AI Summary and downloading transcript...";
      } else if (result.notesStatus === 'done') {
        generateBtn.disabled = false;
        generateBtn.innerText = "Generate AI Summary";
        resultsStatus.style.color = "green";
        resultsStatus.innerText = "Success! AI Summary and Transcript downloaded.";
      } else if (result.notesStatus === 'error') {
        generateBtn.disabled = false;
        generateBtn.innerText = "Retry Generating";
        resultsStatus.style.color = "red";
        resultsStatus.innerText = "Error: " + (result.notesError || "Failed to generate AI summary.");
      } else {
        generateBtn.disabled = false;
        generateBtn.innerText = "Generate AI Summary";
      }
      return;
    }

    // 4. Main View (Action-First Ready to Capture)
    viewApiKey.style.display = "none";
    viewMain.style.display = "block";
    viewResults.style.display = "none";

    issueBanner.style.display = "none";
    stopLink.style.display = "none";
    stopTimer();

    startBtn.disabled = false;
    if (captionHelperText) {
      captionHelperText.style.display = "block";
      captionHelperText.innerText = pageStatus.captionsOn
        ? "Captions enabled and ready."
        : "Live captions will automatically be enabled upon capture.";
    }
    statusEl.innerHTML = "<span style='font-size: 10px; color: #666; display: inline-block; margin-top: 2px; line-height: 1.2;'>By starting, you confirm you have permission from all attendees to transcribe this session.</span>";
  });
}

updateUI();
pollInterval = setInterval(updateUI, 2000);

async function executeInActiveTab(action, callback) {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    if (callback) callback();
    return;
  }
  chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    files: ['content.js']
  }, () => {
    chrome.tabs.sendMessage(tab.id, { action: action }, () => {
      if (chrome.runtime.lastError) {
        // Ignore if frame has no listener
      }
      if (callback) callback();
    });
  });
}

startBtn.addEventListener('click', async () => {
  const startTime = Date.now();
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.storage.local.set({
    savedTranscript: [],
    isTranscribing: true,
    startTime: startTime,
    issueDetected: false,
    activeTabId: tab ? tab.id : null,
    notesStatus: 'idle',
    notesError: '',
    transcriptDownloaded: false,
    callEnded: false
  }, () => {
    executeInActiveTab("start");
    updateUI();
  });
});

stopLink.addEventListener('click', (e) => {
  e.preventDefault();
  executeInActiveTab("stop", () => {
    chrome.storage.local.set({ isTranscribing: false }, () => {
      chrome.runtime.sendMessage({ action: "session_ended" }, () => {
        updateUI();
      });
      updateUI();
    });
  });
});

newSessionBtn.addEventListener('click', () => {
  chrome.storage.local.set({
    savedTranscript: [],
    notesStatus: 'idle',
    notesError: '',
    transcriptDownloaded: false,
    callEnded: false
  }, () => {
    resultsStatus.innerText = "";
    generateBtn.innerText = "Generate AI Summary";
    updateUI();
  });
});

downloadBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: "download_transcript" });
});

generateBtn.addEventListener('click', () => {
  resultsStatus.style.color = "#333";
  resultsStatus.innerText = "Generating AI Summary...";
  generateBtn.disabled = true;
  generateBtn.innerText = "Generating...";

  chrome.runtime.sendMessage({ action: "generate_notes" }, () => {
    updateUI();
  });
});
