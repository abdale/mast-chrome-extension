(function () {
  if (window.__mastContentScriptLoaded) {
    return;
  }
  window.__mastContentScriptLoaded = true;

  let isTranscribing = false;
  let observer = null;

  let CAPTION_CONTAINER_SELECTOR = '[data-tid="closed-captions-container"]';
  let SPEAKER_SELECTOR = '[data-tid="author"]';
  let TEXT_SELECTOR = '[data-tid="closed-caption-text"]';

  let currentSpeaker = "Unknown";
  let issueTimer = null;
  let captionsMap = new Map(); // DOM Element -> { speaker, text }

  let callCheckInterval = null;
  let sawActiveMeeting = false;
  let missingCallChecks = 0;
  let shouldGuardUnload = false;
  let statusToastTimer = null;

  // Beforeunload guard: prompts user if they try to close the tab before AI notes finish downloading
  window.addEventListener('beforeunload', (e) => {
    if (shouldGuardUnload) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  });

  async function fetchRemoteConfig() {
    try {
      const res = await fetch("https://raw.githubusercontent.com/abdale/mast-chrome-extension/main/config.json");
      const json = await res.json();
      if (json.CAPTION_CONTAINER_SELECTOR) CAPTION_CONTAINER_SELECTOR = json.CAPTION_CONTAINER_SELECTOR;
      if (json.SPEAKER_SELECTOR) SPEAKER_SELECTOR = json.SPEAKER_SELECTOR;
      if (json.TEXT_SELECTOR) TEXT_SELECTOR = json.TEXT_SELECTOR;
      console.log("mast: Remote config loaded.");
    } catch (e) {
      console.log("mast: Using default DOM selectors.");
    }
  }

  function isTeamsMeetingActive() {
    const meetingSelectors = [
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
      '[data-tid="closed-caption-renderer-wrapper"]',
      CAPTION_CONTAINER_SELECTOR,
      TEXT_SELECTOR
    ];
    return meetingSelectors.some((sel) => {
      try {
        return !!document.querySelector(sel);
      } catch (_) {
        return false;
      }
    });
  }

  function extractTeamsMeetingTitle() {
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
      try {
        const el = document.querySelector(sel);
        if (el) {
          const candidate = cleanSegment(el.innerText || el.textContent || el.getAttribute('title') || '');
          if (isValidTitle(candidate)) {
            return candidate;
          }
        }
      } catch (_) {}
    }

    const docTitlesToCheck = [];
    if (document.title) docTitlesToCheck.push(document.title);
    try {
      if (window.top && window.top.document && window.top.document.title) {
        docTitlesToCheck.push(window.top.document.title);
      }
    } catch (_) {}

    for (const rawDocTitle of docTitlesToCheck) {
      const cleanDocTitle = cleanSegment(rawDocTitle);
      const parts = cleanDocTitle.split('|').map(cleanSegment).filter(Boolean);
      for (const part of parts) {
        if (isValidTitle(part)) {
          return part;
        }
      }
    }

    return "Meeting";
  }

  function syncMeetingTitleToStorage() {
    if (!isTeamsMeetingActive()) return;
    const title = extractTeamsMeetingTitle();
    if (title && title !== "Meeting") {
      chrome.storage.local.set({ meetingTitle: title });
    }
  }

  function removeStatusToast() {
    if (statusToastTimer) {
      clearTimeout(statusToastTimer);
      statusToastTimer = null;
    }
    const existing = document.getElementById('mast-status-toast');
    if (existing) {
      existing.remove();
    }
  }

  function renderStatusToast(state, errorMessage) {
    if (window !== window.top) return;

    if (statusToastTimer) {
      clearTimeout(statusToastTimer);
      statusToastTimer = null;
    }

    let toast = document.getElementById('mast-status-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'mast-status-toast';
      toast.style.cssText = [
        'position: fixed',
        'bottom: 24px',
        'left: 24px',
        'z-index: 2147483647',
        'background: #ffffff',
        'color: #202124',
        'border: 1px solid #dadce0',
        'border-left: 4px solid #5B5FC7',
        'border-radius: 6px',
        'box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14)',
        'padding: 12px 16px',
        'font-family: Segoe UI, Tahoma, sans-serif',
        'font-size: 13px',
        'line-height: 1.4',
        'max-width: 340px',
        'display: flex',
        'flex-direction: column',
        'gap: 8px'
      ].join('; ');
      document.body.appendChild(toast);
    }

    toast.innerHTML = '';

    const messageEl = document.createElement('div');
    messageEl.style.fontWeight = '500';

    if (state === 'generating') {
      toast.style.borderLeftColor = '#5B5FC7';
      messageEl.textContent = 'mast: Transcript saved. Generating AI notes...';
      toast.appendChild(messageEl);
    } else if (state === 'done') {
      toast.style.borderLeftColor = '#2e7d32';
      messageEl.textContent = 'mast: AI notes and transcript downloaded.';
      toast.appendChild(messageEl);
      statusToastTimer = setTimeout(() => {
        removeStatusToast();
      }, 8000);
    } else if (state === 'error') {
      toast.style.borderLeftColor = '#d32f2f';
      messageEl.textContent = errorMessage
        ? `mast: AI notes failed (${errorMessage}).`
        : 'mast: Transcript downloaded, but AI notes failed.';
      toast.appendChild(messageEl);

      const actionsRow = document.createElement('div');
      actionsRow.style.cssText = 'display: flex; gap: 8px; margin-top: 4px;';

      const retryBtn = document.createElement('button');
      retryBtn.textContent = 'Retry';
      retryBtn.style.cssText = 'background: #5B5FC7; color: #fff; border: none; border-radius: 4px; padding: 5px 10px; font-size: 12px; cursor: pointer; font-weight: 500;';
      retryBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'generate_notes' });
      });

      const dismissBtn = document.createElement('button');
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.style.cssText = 'background: transparent; color: #5f6368; border: 1px solid #dadce0; border-radius: 4px; padding: 5px 10px; font-size: 12px; cursor: pointer;';
      dismissBtn.addEventListener('click', () => {
        shouldGuardUnload = false;
        removeStatusToast();
      });

      actionsRow.appendChild(retryBtn);
      actionsRow.appendChild(dismissBtn);
      toast.appendChild(actionsRow);
    }
  }

  function flushCaptionsToStorage() {
    const transcriptLines = [];
    for (let data of captionsMap.values()) {
      if (data.text) {
        transcriptLines.push(`[${data.speaker}]: ${data.text}`);
      }
    }
    if (transcriptLines.length > 0) {
      chrome.storage.local.set({ savedTranscript: transcriptLines });
    }
  }

  function stopLocalObservation() {
    isTranscribing = false;
    flushCaptionsToStorage();
    captionsMap.clear();
    if (issueTimer) {
      clearTimeout(issueTimer);
      issueTimer = null;
    }
    if (callCheckInterval) {
      clearInterval(callCheckInterval);
      callCheckInterval = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    sawActiveMeeting = false;
    missingCallChecks = 0;
  }

  function startCallEndPolling() {
    if (callCheckInterval) clearInterval(callCheckInterval);
    sawActiveMeeting = isTeamsMeetingActive();
    missingCallChecks = 0;
    syncMeetingTitleToStorage();

    callCheckInterval = setInterval(() => {
      if (!isTranscribing) {
        clearInterval(callCheckInterval);
        callCheckInterval = null;
        return;
      }

      const active = isTeamsMeetingActive();
      if (active) {
        sawActiveMeeting = true;
        missingCallChecks = 0;
        syncMeetingTitleToStorage();
        return;
      }

      // Only auto-stop if this frame previously saw an active meeting
      if (sawActiveMeeting) {
        missingCallChecks += 1;
        if (missingCallChecks >= 3) {
          console.log("mast: Call end detected. Finalizing session and auto-generating AI notes.");
          stopLocalObservation();
          chrome.storage.local.set({ callEnded: true }, () => {
            chrome.runtime.sendMessage({ action: "session_ended" });
          });
        }
      }
    }, 2000);
  }

  async function startObserving() {
    if (observer) return;
    await fetchRemoteConfig();
    console.log("mast: startObserving() called. Looking for captions...");
    syncMeetingTitleToStorage();

    chrome.storage.local.set({ issueDetected: false });
    if (issueTimer) clearTimeout(issueTimer);
    issueTimer = setTimeout(() => {
      if (captionsMap.size === 0) {
        chrome.storage.local.set({ issueDetected: true });
      }
    }, 5 * 60 * 1000); // 5 minutes

    const targetNode = document.querySelector('body');
    if (!targetNode) return;

    observer = new MutationObserver((mutations) => {
      if (!isTranscribing) return;

      let domChanged = false;

      // 1. Check for newly added caption or speaker elements
      mutations.forEach((mutation) => {
        for (let node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check for speaker
            const speakerEl = node.matches(SPEAKER_SELECTOR) ? node : node.querySelector(SPEAKER_SELECTOR);
            if (speakerEl && speakerEl.innerText && speakerEl.innerText.trim()) {
              currentSpeaker = speakerEl.innerText.trim();
              console.log("mast: Found speaker:", currentSpeaker);
            }

            // Check for text elements
            const textEls = node.matches(TEXT_SELECTOR) ? [node] : node.querySelectorAll(TEXT_SELECTOR);
            for (let textEl of textEls) {
              if (!captionsMap.has(textEl)) {
                captionsMap.set(textEl, { speaker: currentSpeaker, text: textEl.innerText ? textEl.innerText.trim() : "" });
                domChanged = true;
              }
            }
          }
        }
      });

      // 2. On EVERY mutation, sync the text for ALL tracked caption elements still on screen
      for (let [textEl, data] of captionsMap.entries()) {
        if (document.body.contains(textEl)) {
          const newText = textEl.innerText ? textEl.innerText.trim() : "";
          // Only update if the text actually changed and isn't empty
          if (newText && newText !== data.text) {
            data.text = newText;
            domChanged = true;
          }
        }
      }

      // 3. If anything changed, save the entire consolidated map to storage
      if (domChanged) {
        const transcriptLines = [];
        for (let data of captionsMap.values()) {
          if (data.text) {
            transcriptLines.push(`[${data.speaker}]: ${data.text}`);
          }
        }
        chrome.storage.local.set({ savedTranscript: transcriptLines });
      }
    });

    observer.observe(targetNode, { childList: true, subtree: true, characterData: true });
    startCallEndPolling();
  }

  // React to background generation status updates
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.notesStatus) {
      const status = changes.notesStatus.newValue;
      if (status === 'generating') {
        shouldGuardUnload = true;
        renderStatusToast('generating');
      } else if (status === 'done') {
        shouldGuardUnload = false;
        renderStatusToast('done');
      } else if (status === 'error') {
        shouldGuardUnload = true;
        chrome.storage.local.get(['notesError'], (res) => {
          renderStatusToast('error', res.notesError);
        });
      } else if (status === 'idle') {
        shouldGuardUnload = false;
        removeStatusToast();
      }
    }
  });

  function areCaptionsVisible() {
    const captionSelectors = [
      CAPTION_CONTAINER_SELECTOR,
      TEXT_SELECTOR,
      SPEAKER_SELECTOR,
      '[data-tid="closed-captions-container"]',
      '[data-tid="closed-caption-renderer-wrapper"]',
      '[data-tid="closed-caption-text"]',
      '.ui-captions-container'
    ];
    return captionSelectors.some((sel) => {
      try {
        return !!document.querySelector(sel);
      } catch (_) {
        return false;
      }
    });
  }

  function ensureCaptionsEnabled() {
    if (areCaptionsVisible()) {
      console.log("mast: Captions already active.");
      return;
    }
    console.log("mast: Attempting to enable captions via Alt+Shift+C");
    const event = new KeyboardEvent('keydown', {
      key: 'c',
      code: 'KeyC',
      keyCode: 67,
      which: 67,
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    });
    document.dispatchEvent(event);
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "start") {
      shouldGuardUnload = false;
      removeStatusToast();
      isTranscribing = true;
      ensureCaptionsEnabled();
      startObserving();
      sendResponse({ status: "started" });
    } else if (request.action === "stop") {
      stopLocalObservation();
      sendResponse({ status: "stopped" });
    } else if (request.action === "force_captions") {
      ensureCaptionsEnabled();
      sendResponse({ status: "force_captions_sent" });
    }
  });
})();
