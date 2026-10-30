const viewApiKey = document.getElementById('view-api-key');
const viewNoCall = document.getElementById('view-no-call');
const viewMain = document.getElementById('view-main');
const viewResults = document.getElementById('view-results');

const apiKeyInput = document.getElementById('apiKeyInput');
const validateBtn = document.getElementById('validateBtn');
const apiError = document.getElementById('apiError');

const startBtn = document.getElementById('startBtn');
const captionHelperText = document.getElementById('captionHelperText');
const enableCaptionsBtn = document.getElementById('enableCaptionsBtn');
const issueBanner = document.getElementById('issueBanner');
const stopLink = document.getElementById('stopLink');
const statusEl = document.getElementById('status');
const timerEl = document.getElementById('timer');
const settingsLink = document.getElementById('settingsLink');

const resultsStatus = document.getElementById('resultsStatus');
const retryBtn = document.getElementById('retryBtn');
const dismissBtn = document.getElementById('dismissBtn');

let timerInterval = null;
let pollInterval = null;
let sawSessionTransitionInPopup = false;

const WORKER_BUILD_VERSION = '2.8.1';
chrome.runtime.sendMessage({ action: 'get_worker_version' }, (res) => {
  if (chrome.runtime.lastError || !res || res.version !== WORKER_BUILD_VERSION) {
    chrome.runtime.reload();
  }
});

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
    const preferredModel = topFlash.length >= 2 ? topFlash[1] : topFlash[0];
    const defaultModel = preferredModel ? preferredModel.name.replace('models/', '') : 'gemini-2.5-flash';

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

async function checkPageStatus(preferredTabId = null) {
  let [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let tab = activeTab;

  if (preferredTabId && (!activeTab || activeTab.id !== preferredTabId)) {
    try {
      const preferredTab = await chrome.tabs.get(preferredTabId);
      if (preferredTab) tab = preferredTab;
    } catch (_) {}
  }

  if (!tab) return { captionsOn: false, inActiveCall: false, meetingTitle: "Meeting" };

  let msgStatus = null;
  try {
    msgStatus = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { action: "get_status" }, (res) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(res || null);
        }
      });
    });
  } catch (_) {}

  const tabUrl = (tab.url || '').toLowerCase();
  const isTeamsTab =
    tabUrl.includes('teams.microsoft.com') ||
    tabUrl.includes('teams.live.com') ||
    tabUrl.includes('teams.cloud.microsoft');
  if (!isTeamsTab && !msgStatus) {
    return { captionsOn: false, inActiveCall: false, meetingTitle: "Meeting" };
  }

  let captionsOn = !!(msgStatus && msgStatus.captionsOn);
  let inActiveCall = !!(msgStatus && msgStatus.inActiveCall);
  let meetingTitle = msgStatus && msgStatus.meetingTitle ? msgStatus.meetingTitle : "Meeting";

  try {
    let results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        const captionsOn = !!document.querySelector(
          '[data-tid="closed-captions-container"], [data-tid="closed-caption-renderer-wrapper"], [data-tid="closed-caption-text"], [data-tid="author"], .ui-captions-container, [data-tid*="closed-caption" i], [data-tid*="captions-container" i], [data-tid*="caption-renderer" i], [aria-label*="Live captions" i], [aria-label*="Closed captions" i]'
        );
        const isPreJoin =
          !!document.querySelector(
            '[data-tid="prejoin-join-button"], button[data-tid="prejoin-join-button"], button[aria-label^="Join now" i]'
          ) &&
          !document.querySelector('#hangup-button, [data-tid="hangup-main-btn"], [data-tid="hangup-button"]');

        const inActiveCall =
          captionsOn ||
          (!isPreJoin &&
            !!document.querySelector(
              '[data-tid="call-duration"], #hangup-button, button[data-tid="hangup-button"], [data-tid="hangup-main-btn"], [data-tid="hangup-chevron-btn"], button[data-tid="call-hangup"], button[id*="hangup" i], button[data-tid*="hangup" i], button[aria-label="Leave" i], button[aria-label^="Leave (" i], button[aria-label*="Leave call" i], button[aria-label*="Leave meeting" i], button[aria-label*="Hang up" i], #callingButtons-showMoreBtn, [data-tid="callingButtons-showMoreBtn"], #share-button, [data-tid="share-button"], [data-tid="calling-top-bar"], [data-tid="calling-screen"], [data-tid="meeting-stage"], [data-tid="calling-stage"], [data-tid="modern-calling-Header"], [data-tid="call-Composite"], [data-tid="call-status-container"]'
            ));

        const genericNames = new Set([
          'microsoft teams',
          'teams',
          'chat',
          'calendar',
          'activity',
          'calls',
          'files',
          'onedrive',
          'approvals',
          'meeting',
          'general',
          'unknown'
        ]);
        const cleanSegment = (str) => (str || '').replace(/^\(\d+\)\s*/, '').replace(/\s+/g, ' ').trim();
        const isValidTitle = (str) => {
          if (!str || str.length < 2) return false;
          if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(str)) return false;
          return !genericNames.has(str.toLowerCase());
        };

        let meetingTitle = "Meeting";
        const titleSelectors = [
          '[data-tid="call-title"]',
          '[data-tid="meeting-title"]',
          '[data-tid="calling-header-title"]',
          '[data-tid="SimplifiedCallHeader-title"]',
          '[data-tid="ubar-header-title"]',
          '[data-tid="calling-top-bar"] [data-tid*="title" i]',
          '[aria-label*="Meeting title" i]',
          '.meeting-title',
          '.call-title'
        ];
        for (const sel of titleSelectors) {
          const el = document.querySelector(sel);
          if (el) {
            const candidate = cleanSegment(el.innerText || el.textContent || el.getAttribute('title') || '');
            if (isValidTitle(candidate)) {
              meetingTitle = candidate;
              break;
            }
          }
        }

        if (meetingTitle === "Meeting" && document.title) {
          const cleanDocTitle = cleanSegment(document.title);
          const parts = cleanDocTitle.split('|').map(cleanSegment).filter(Boolean);
          for (const part of parts) {
            if (isValidTitle(part)) {
              meetingTitle = part;
              break;
            }
          }
        }

        return { captionsOn: captionsOn, inActiveCall: inActiveCall, meetingTitle: meetingTitle };
      }
    });
    if (results) {
      for (let r of results) {
        if (r.result) {
          if (r.result.captionsOn) captionsOn = true;
          if (r.result.inActiveCall) inActiveCall = true;
          if (r.result.meetingTitle && r.result.meetingTitle !== "Meeting") meetingTitle = r.result.meetingTitle;
        }
      }
    }
  } catch (_) {}

  if (inActiveCall && meetingTitle === "Meeting" && tab.title) {
    const genericNames = new Set([
      'microsoft teams',
      'teams',
      'chat',
      'calendar',
      'activity',
      'calls',
      'files',
      'onedrive',
      'approvals',
      'meeting',
      'general',
      'unknown'
    ]);
    const cleanSegment = (str) => (str || '').replace(/^\(\d+\)\s*/, '').replace(/\s+/g, ' ').trim();
    const parts = cleanSegment(tab.title).split('|').map(cleanSegment).filter(Boolean);
    for (const part of parts) {
      if (part.length >= 2 && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(part) && !genericNames.has(part.toLowerCase())) {
        meetingTitle = part;
        break;
      }
    }
  }

  return { captionsOn, inActiveCall, meetingTitle };
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
    'completionUnseen',
    'callEnded',
    'generationStartedAt',
    'liveCaptionsOn'
  ], async (result) => {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const targetTabId = result.isTranscribing && result.activeTabId ? result.activeTabId : (tab ? tab.id : null);
    const pageStatus = await checkPageStatus(targetTabId);

    if (pageStatus.inActiveCall && pageStatus.meetingTitle && pageStatus.meetingTitle !== "Meeting") {
      chrome.storage.local.set({ meetingTitle: pageStatus.meetingTitle });
    }

    let currentTabId = tab ? tab.id : null;
    const hasUnseenCompletion = !!(result.notesStatus === 'done' && result.completionUnseen);
    const switchedToNewTab = !!(
      result.activeTabId &&
      result.activeTabId !== currentTabId &&
      !result.isTranscribing &&
      !sawSessionTransitionInPopup &&
      !hasUnseenCompletion
    );
    const startedNewCallInSameTab = !!(result.callEnded && pageStatus.inActiveCall && !result.isTranscribing);
    const inNewActiveMeeting = !!(pageStatus.inActiveCall && (switchedToNewTab || result.callEnded) && !result.isTranscribing);
    const reopenedAfterCompletion = !!(
      (result.notesStatus === 'done' || !result.notesStatus || result.notesStatus === 'idle') &&
      !sawSessionTransitionInPopup &&
      !hasUnseenCompletion &&
      !result.isTranscribing
    );
    const isGeneratingStale =
      result.notesStatus === 'generating' &&
      (!result.generationStartedAt || Date.now() - result.generationStartedAt > 75000);

    // Never reset state while actively transcribing
    if (
      !result.isTranscribing &&
      result.savedTranscript &&
      result.savedTranscript.length > 0 &&
      (switchedToNewTab || startedNewCallInSameTab || reopenedAfterCompletion) &&
      (result.notesStatus !== 'generating' || isGeneratingStale) &&
      (result.notesStatus !== 'error' || inNewActiveMeeting)
    ) {
      const nextMeetingTitle =
        pageStatus.inActiveCall && pageStatus.meetingTitle && pageStatus.meetingTitle !== "Meeting"
          ? pageStatus.meetingTitle
          : "Meeting";
      chrome.storage.local.set({
        savedTranscript: [],
        isTranscribing: false,
        notesStatus: 'idle',
        notesError: '',
        completionUnseen: false,
        transcriptDownloaded: false,
        callEnded: false,
        meetingTitle: nextMeetingTitle
      });
      result.savedTranscript = [];
      result.isTranscribing = false;
      result.notesStatus = 'idle';
      result.notesError = '';
      result.completionUnseen = false;
      result.callEnded = false;
    }

    // 1. API Key View
    if (!result.apiKey) {
      viewApiKey.style.display = "block";
      if (viewNoCall) viewNoCall.style.display = "none";
      viewMain.style.display = "none";
      viewResults.style.display = "none";
      validateBtn.innerText = "Save & Validate";
      validateBtn.disabled = false;
      return;
    }

    const hasTranscript = result.savedTranscript && result.savedTranscript.length > 0;

    // 2. Transcribing in progress always shows Main View (even when viewing another tab)
    if (result.isTranscribing) {
      sawSessionTransitionInPopup = true;
      viewApiKey.style.display = "none";
      if (viewNoCall) viewNoCall.style.display = "none";
      viewMain.style.display = "block";
      viewResults.style.display = "none";

      if (result.issueDetected) {
        issueBanner.style.display = "block";
      } else {
        issueBanner.style.display = "none";
      }

      if (captionHelperText) {
        captionHelperText.style.display = "none";
      }

      stopLink.style.display = "block";

      const startTime = result.startTime || Date.now();
      startTimer(startTime);

      const captionsCurrentlyOn = pageStatus.captionsOn || result.liveCaptionsOn === true;
      const captionsOffWarning = !captionsCurrentlyOn && Date.now() - startTime >= 4000;

      if (captionsOffWarning) {
        startBtn.style.display = "none";
        if (enableCaptionsBtn) {
          enableCaptionsBtn.style.display = "block";
        }
        statusEl.style.color = "#d32f2f";
        statusEl.innerText = "Live captions are off. Enable captions to continue capturing.";
      } else {
        startBtn.style.display = "block";
        startBtn.disabled = true;
        if (enableCaptionsBtn) {
          enableCaptionsBtn.style.display = "none";
          enableCaptionsBtn.disabled = false;
          enableCaptionsBtn.innerText = "Enable Captions";
        }
        statusEl.style.color = "#333";
        statusEl.innerText = "Transcribing in progress...";
      }
      return;
    }

    // 3. Results View: if not transcribing but we have a transcript
    if (!result.isTranscribing && hasTranscript) {
      sawSessionTransitionInPopup = true;
      viewApiKey.style.display = "none";
      if (viewNoCall) viewNoCall.style.display = "none";
      viewMain.style.display = "none";
      viewResults.style.display = "block";
      stopTimer();

      if (result.notesStatus === 'generating') {
        resultsStatus.style.color = "#5f6368";
        resultsStatus.innerText = "Generating AI meeting notes and saving transcript...";
        if (retryBtn) retryBtn.style.display = "none";
        if (dismissBtn) dismissBtn.style.display = "none";
        chrome.runtime.sendMessage({ action: "check_generation_status" }, () => {
          void chrome.runtime.lastError;
        });
      } else if (result.notesStatus === 'error') {
        resultsStatus.style.color = "#d32f2f";
        resultsStatus.innerText = "Transcript saved, but AI notes failed to generate." + (result.notesError ? " (" + result.notesError + ")" : "");
        if (retryBtn) {
          retryBtn.style.display = "block";
          retryBtn.disabled = false;
          retryBtn.innerText = "Retry";
        }
        if (dismissBtn) {
          dismissBtn.style.display = "block";
        }
      } else {
        if (result.completionUnseen) {
          chrome.storage.local.set({ completionUnseen: false });
        }
        resultsStatus.style.color = "#5f6368";
        resultsStatus.innerText = "Your AI meeting notes and transcript have been saved to your Downloads folder.";
        if (retryBtn) retryBtn.style.display = "none";
        if (dismissBtn) dismissBtn.style.display = "none";
      }
      return;
    }

    // 4. No Active Teams Call View
    if (!pageStatus.inActiveCall) {
      viewApiKey.style.display = "none";
      if (viewNoCall) viewNoCall.style.display = "block";
      viewMain.style.display = "none";
      viewResults.style.display = "none";
      stopTimer();
      return;
    }

    // 5. Main View (Action-First Ready to Capture inside an active Teams call)
    viewApiKey.style.display = "none";
    if (viewNoCall) viewNoCall.style.display = "none";
    viewMain.style.display = "block";
    viewResults.style.display = "none";

    issueBanner.style.display = "none";
    stopLink.style.display = "none";
    stopTimer();

    startBtn.style.display = "block";
    startBtn.disabled = false;
    if (enableCaptionsBtn) {
      enableCaptionsBtn.style.display = "none";
      enableCaptionsBtn.disabled = false;
      enableCaptionsBtn.innerText = "Enable Captions";
    }
    if (captionHelperText) {
      captionHelperText.style.display = "block";
      captionHelperText.style.color = "#5f6368";
      captionHelperText.innerText = pageStatus.captionsOn
        ? "Captions enabled and ready. Do not disable live captions during the call."
        : "Live captions will be automatically enabled upon capture. Do not disable live captions during the call.";
    }
    statusEl.style.color = "#333";
    statusEl.innerText = "";
  });
}

updateUI();
pollInterval = setInterval(updateUI, 2000);

async function executeInActiveTab(action, callback, preferredTabId = null) {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const stored = await chrome.storage.local.get(['activeTabId']);
  const targetTabId = preferredTabId || stored.activeTabId || (tab ? tab.id : null);
  if (!targetTabId) {
    if (callback) callback();
    return;
  }
  chrome.scripting.executeScript({
    target: { tabId: targetTabId, allFrames: true },
    files: ['content.js']
  }, () => {
    void chrome.runtime.lastError;
    chrome.tabs.sendMessage(targetTabId, { action: action }, () => {
      void chrome.runtime.lastError;
      if (callback) callback();
    });
  });
}

startBtn.addEventListener('click', async () => {
  sawSessionTransitionInPopup = true;
  const startTime = Date.now();
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pageStatus = await checkPageStatus(tab ? tab.id : null);
  const initialMeetingTitle =
    pageStatus.meetingTitle && pageStatus.meetingTitle !== "Meeting"
      ? pageStatus.meetingTitle
      : "Meeting";
  chrome.storage.local.set({
    savedTranscript: [],
    isTranscribing: true,
    startTime: startTime,
    issueDetected: false,
    activeTabId: tab ? tab.id : null,
    notesStatus: 'idle',
    notesError: '',
    completionUnseen: false,
    transcriptDownloaded: false,
    callEnded: false,
    liveCaptionsOn: true,
    meetingTitle: initialMeetingTitle
  }, () => {
    executeInActiveTab("start", null, tab ? tab.id : null);
    updateUI();
  });
});

stopLink.addEventListener('click', async (e) => {
  e.preventDefault();
  sawSessionTransitionInPopup = true;
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const stored = await chrome.storage.local.get(['activeTabId']);
  const targetTabId = stored.activeTabId || (tab ? tab.id : null);
  chrome.storage.local.set(
    {
      isTranscribing: false,
      notesStatus: 'generating',
      generationStartedAt: Date.now()
    },
    () => {
      chrome.runtime.sendMessage({ action: "stop_and_finalize", tabId: targetTabId }, () => {
        void chrome.runtime.lastError;
        updateUI();
      });
      executeInActiveTab("stop", () => {
        updateUI();
      }, targetTabId);
      updateUI();
    }
  );
});

if (enableCaptionsBtn) {
  enableCaptionsBtn.addEventListener('click', async () => {
    enableCaptionsBtn.disabled = true;
    enableCaptionsBtn.innerText = "Enabling...";
    const stored = await chrome.storage.local.get(['activeTabId']);
    executeInActiveTab("force_captions", () => {
      setTimeout(() => {
        enableCaptionsBtn.disabled = false;
        enableCaptionsBtn.innerText = "Enable Captions";
        updateUI();
      }, 1000);
    }, stored.activeTabId || null);
  });
}

if (retryBtn) {
  retryBtn.addEventListener('click', () => {
    retryBtn.disabled = true;
    retryBtn.innerText = "Retrying...";
    if (dismissBtn) dismissBtn.style.display = "none";
    resultsStatus.style.color = "#5f6368";
    resultsStatus.innerText = "Generating AI meeting notes and saving transcript...";
    chrome.runtime.sendMessage({ action: "generate_notes" }, () => {
      void chrome.runtime.lastError;
      updateUI();
    });
  });
}

if (dismissBtn) {
  dismissBtn.addEventListener('click', () => {
    chrome.storage.local.set(
      {
        savedTranscript: [],
        isTranscribing: false,
        notesStatus: 'idle',
        notesError: '',
        completionUnseen: false,
        transcriptDownloaded: false,
        callEnded: false
      },
      () => {
        updateUI();
      }
    );
  });
}
