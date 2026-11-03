(function () {
  const CONTENT_SCRIPT_VERSION = '2.9.3';
  if (window.__mastContentScriptVersion === CONTENT_SCRIPT_VERSION) {
    return;
  }
  if (typeof window.__mastContentScriptCleanup === 'function') {
    try {
      window.__mastContentScriptCleanup();
    } catch (_) {}
  }
  window.__mastContentScriptVersion = CONTENT_SCRIPT_VERSION;
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
  let meetingDetectInterval = null;
  let sawActiveMeeting = false;
  let missingCallChecks = 0;
  let shouldGuardUnload = false;
  let statusToastTimer = null;
  let currentToastState = null;
  let sawCaptionsActive = false;
  let captionsOffDismissed = false;
  let meetingDetectedToastDismissed = false;
  let transcriptionStartedAt = 0;
  let lastRecentSyncAt = 0;

  let lastChildFrameActiveAt = 0;
  let lastChildFrameCaptionsAt = 0;
  let lastChildFrameTitle = "Meeting";

  function onBeforeUnload(e) {
    if (shouldGuardUnload) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  }
  window.addEventListener('beforeunload', onBeforeUnload);

  function onWindowMessage(e) {
    if (window !== window.top) return;
    const data = e && e.data;
    if (!data || data.type !== 'MAST_FRAME_MEETING_STATUS') return;
    if (data.active) {
      lastChildFrameActiveAt = Date.now();
    }
    if (data.captionsVisible) {
      lastChildFrameCaptionsAt = Date.now();
    }
    if (data.title && data.title !== 'Meeting') {
      lastChildFrameTitle = data.title;
    }
  }
  window.addEventListener('message', onWindowMessage);

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

  function isTeamsMeetingActiveLocal() {
    try {
      const isPreJoin = !!document.querySelector(
        '[data-tid="prejoin-join-button"], button[data-tid="prejoin-join-button"], button[aria-label^="Join now" i]'
      );
      if (isPreJoin && !document.querySelector('#hangup-button, [data-tid="hangup-main-btn"], [data-tid="hangup-button"]')) {
        return false;
      }
    } catch (_) {}

    const meetingSelectors = [
      '[data-tid="call-duration"]',
      '#hangup-button',
      'button[data-tid="hangup-button"]',
      '[data-tid="hangup-main-btn"]',
      '[data-tid="hangup-chevron-btn"]',
      'button[data-tid="call-hangup"]',
      'button[id*="hangup" i]',
      'button[data-tid*="hangup" i]',
      'button[aria-label="Leave" i]',
      'button[aria-label^="Leave (" i]',
      'button[aria-label*="Leave call" i]',
      'button[aria-label*="Leave meeting" i]',
      'button[aria-label*="Hang up" i]',
      '#callingButtons-showMoreBtn',
      '[data-tid="callingButtons-showMoreBtn"]',
      '#share-button',
      '[data-tid="share-button"]',
      '[data-tid="calling-top-bar"]',
      '[data-tid="calling-screen"]',
      '[data-tid="meeting-stage"]',
      '[data-tid="calling-stage"]',
      '[data-tid="modern-calling-Header"]',
      '[data-tid="call-Composite"]',
      '[data-tid="call-status-container"]',
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

  function isTeamsMeetingActive() {
    if (isTeamsMeetingActiveLocal()) return true;
    if (window === window.top && Date.now() - lastChildFrameActiveAt < 4500) {
      return true;
    }
    return false;
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

    if (window === window.top && lastChildFrameTitle && isValidTitle(lastChildFrameTitle)) {
      return lastChildFrameTitle;
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
      try {
        chrome.storage.local.set({ meetingTitle: title });
      } catch (_) {}
    }
  }

  function formatShortDate(dateObj = new Date()) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    return `${months[dateObj.getMonth()]}${dateObj.getDate()}-${dateObj.getFullYear()}`;
  }

  function syncTranscriptToRecentMeetings(lines, force = false) {
    if (!lines || lines.length === 0) return;
    const now = Date.now();
    if (!force && now - lastRecentSyncAt < 3000) return;
    lastRecentSyncAt = now;

    try {
      chrome.storage.local.get(['recentMeetings', 'startTime', 'meetingTitle'], (stored) => {
        if (chrome.runtime.lastError) return;
        const recent = Array.isArray(stored.recentMeetings) ? stored.recentMeetings : [];
        const sessionTimestamp = stored.startTime || transcriptionStartedAt || now;
        const sessionId = String(sessionTimestamp);
        const dateObj = new Date(sessionTimestamp);
        const shortDate = formatShortDate(dateObj);
        const displayDate = dateObj.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric'
        });

        const liveTitle = extractTeamsMeetingTitle();
        const rawTitle = liveTitle !== 'Meeting' ? liveTitle : (stored.meetingTitle || 'Meeting');
        const cleanTitle = rawTitle && typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : 'Meeting';

        const existingIdx = recent.findIndex((m) => m.id === sessionId);
        const existingEntry = existingIdx >= 0 ? recent[existingIdx] : null;

        const entry = {
          id: sessionId,
          title: existingEntry && cleanTitle === 'Meeting' ? existingEntry.title : cleanTitle,
          teamsTitle: cleanTitle !== 'Meeting' ? cleanTitle : (existingEntry?.teamsTitle || 'Meeting'),
          shortDate,
          displayDate,
          timestamp: sessionTimestamp,
          lines
        };

        if (existingIdx >= 0) {
          recent.splice(existingIdx, 1);
        }
        recent.unshift(entry);

        chrome.storage.local.set({
          recentMeetings: recent.slice(0, 5),
          startTime: sessionTimestamp
        });
      });
    } catch (_) {}
  }

  function removeStatusToast() {
    if (statusToastTimer) {
      clearTimeout(statusToastTimer);
      statusToastTimer = null;
    }
    currentToastState = null;
    const existing = document.getElementById('mast-status-toast');
    if (existing) {
      existing.remove();
    }
  }

  function updateToastProgressUI(progress, stage) {
    const fill = document.getElementById('mast-toast-progress-fill');
    const label = document.getElementById('mast-toast-progress-label');
    if (!fill || !label) return;
    const pct = Math.max(0, Math.min(100, Math.round(typeof progress === 'number' ? progress : 0)));
    fill.style.width = `${Math.max(4, pct)}%`;
    label.innerHTML = '';
    const stageSpan = document.createElement('span');
    stageSpan.style.cssText = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
    stageSpan.textContent = stage || 'Generating meeting notes...';
    const pctEl = document.createElement('strong');
    pctEl.style.cssText = 'color: #5B5FC7; flex-shrink: 0;';
    pctEl.textContent = `${pct}%`;
    label.appendChild(stageSpan);
    label.appendChild(pctEl);
  }

  function renderStatusToast(state, errorMessage) {
    if (window !== window.top) return;

    if (statusToastTimer) {
      clearTimeout(statusToastTimer);
      statusToastTimer = null;
    }
    currentToastState = state;

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

    if (state === 'meeting_detected') {
      toast.style.borderLeftColor = '#5B5FC7';
      messageEl.textContent = 'mast: Teams meeting detected.';
      toast.appendChild(messageEl);

      const subEl = document.createElement('div');
      subEl.style.cssText = 'font-size: 12px; color: #5f6368; font-weight: 400;';
      subEl.textContent = 'Capture live captions and generate AI meeting notes.';
      toast.appendChild(subEl);

      const actionsRow = document.createElement('div');
      actionsRow.style.cssText = 'display: flex; gap: 8px; margin-top: 4px;';

      const captureBtn = document.createElement('button');
      captureBtn.textContent = 'Capture Meeting Notes';
      captureBtn.style.cssText =
        'background: #5B5FC7; color: #fff; border: none; border-radius: 4px; padding: 6px 12px; font-size: 12px; cursor: pointer; font-weight: 500;';
      captureBtn.addEventListener('click', () => {
        captureBtn.disabled = true;
        captureBtn.textContent = 'Starting...';
        const title = extractTeamsMeetingTitle();
        chrome.runtime.sendMessage({ action: 'start_from_toast', meetingTitle: title }, (res) => {
          void chrome.runtime.lastError;
          if (res && res.status === 'choose_mode') {
            renderStatusToast('choose_mode');
            return;
          }
          if (res && res.status === 'no_api_key') {
            renderStatusToast('api_key_needed');
            return;
          }
          if (res && res.status === 'nano_unavailable') {
            renderStatusToast('nano_unavailable', res.reason);
            return;
          }
          isTranscribing = true;
          transcriptionStartedAt = (res && res.startTime) || Date.now();
          sawCaptionsActive = areCaptionsVisible();
          captionsOffDismissed = false;
          ensureCaptionsEnabled();
          startObserving();
          renderStatusToast('capturing_started');
        });
      });

      const dismissBtn = document.createElement('button');
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.style.cssText =
        'background: transparent; color: #5f6368; border: 1px solid #dadce0; border-radius: 4px; padding: 6px 10px; font-size: 12px; cursor: pointer;';
      dismissBtn.addEventListener('click', () => {
        meetingDetectedToastDismissed = true;
        removeStatusToast();
      });

      actionsRow.appendChild(captureBtn);
      actionsRow.appendChild(dismissBtn);
      toast.appendChild(actionsRow);
    } else if (state === 'choose_mode') {
      toast.style.borderLeftColor = '#5B5FC7';
      messageEl.textContent = 'mast: Choose how to generate meeting notes:';
      toast.appendChild(messageEl);

      const subEl = document.createElement('div');
      subEl.style.cssText = 'font-size: 11.5px; color: #5f6368; line-height: 1.4;';
      subEl.textContent =
        'Select Gemini Nano (On-Device) with no API key required, or use a Google AI Studio API key.';
      toast.appendChild(subEl);

      const actionsRow = document.createElement('div');
      actionsRow.style.cssText = 'display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap;';

      const nanoBtn = document.createElement('button');
      nanoBtn.textContent = 'Gemini Nano (On-Device)';
      nanoBtn.style.cssText =
        'background: #5B5FC7; color: #fff; border: none; border-radius: 4px; padding: 6px 10px; font-size: 11.5px; cursor: pointer; font-weight: 500;';
      nanoBtn.addEventListener('click', () => {
        nanoBtn.disabled = true;
        nanoBtn.textContent = 'Starting...';
        const title = extractTeamsMeetingTitle();
        chrome.runtime.sendMessage(
          { action: 'start_from_toast', meetingTitle: title, chosenMode: 'nano' },
          (res) => {
            void chrome.runtime.lastError;
            if (res && res.status === 'nano_unavailable') {
              renderStatusToast('nano_unavailable', res.reason);
              return;
            }
            isTranscribing = true;
            transcriptionStartedAt = (res && res.startTime) || Date.now();
            sawCaptionsActive = areCaptionsVisible();
            captionsOffDismissed = false;
            ensureCaptionsEnabled();
            startObserving();
            renderStatusToast('capturing_started');
          }
        );
      });

      const cloudBtn = document.createElement('button');
      cloudBtn.textContent = 'Gemini Flash (API Key)';
      cloudBtn.style.cssText =
        'background: #ffffff; color: #5B5FC7; border: 1px solid #5B5FC7; border-radius: 4px; padding: 6px 10px; font-size: 11.5px; cursor: pointer; font-weight: 500;';
      cloudBtn.addEventListener('click', () => {
        const title = extractTeamsMeetingTitle();
        chrome.runtime.sendMessage(
          { action: 'start_from_toast', meetingTitle: title, chosenMode: 'cloud' },
          (res) => {
            void chrome.runtime.lastError;
            if (res && res.status === 'no_api_key') {
              renderStatusToast('api_key_needed');
              return;
            }
            isTranscribing = true;
            transcriptionStartedAt = (res && res.startTime) || Date.now();
            sawCaptionsActive = areCaptionsVisible();
            captionsOffDismissed = false;
            ensureCaptionsEnabled();
            startObserving();
            renderStatusToast('capturing_started');
          }
        );
      });

      actionsRow.appendChild(nanoBtn);
      actionsRow.appendChild(cloudBtn);
      toast.appendChild(actionsRow);
    } else if (state === 'capturing_started') {
      toast.style.borderLeftColor = '#2e7d32';
      messageEl.textContent = 'mast: Capturing meeting notes...';
      toast.appendChild(messageEl);
      statusToastTimer = setTimeout(() => {
        if (currentToastState === 'capturing_started') {
          removeStatusToast();
        }
      }, 3500);
    } else if (state === 'api_key_needed') {
      toast.style.borderLeftColor = '#d9534f';
      messageEl.textContent = 'mast: Google AI Studio API key needed.';
      toast.appendChild(messageEl);

      const hintEl = document.createElement('div');
      hintEl.style.cssText = 'font-size: 11.5px; color: #5f6368; line-height: 1.4;';
      hintEl.textContent =
        "If you don't have an API key, you can select Gemini On-Device instead - no API key required.";
      toast.appendChild(hintEl);

      const actionsRow = document.createElement('div');
      actionsRow.style.cssText = 'display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap;';

      const useNanoBtn = document.createElement('button');
      useNanoBtn.textContent = 'Use Gemini On-Device';
      useNanoBtn.style.cssText =
        'background: #5B5FC7; color: #fff; border: none; border-radius: 4px; padding: 5px 10px; font-size: 11.5px; cursor: pointer; font-weight: 500;';
      useNanoBtn.addEventListener('click', () => {
        useNanoBtn.disabled = true;
        useNanoBtn.textContent = 'Starting...';
        const title = extractTeamsMeetingTitle();
        chrome.runtime.sendMessage(
          { action: 'start_from_toast', meetingTitle: title, chosenMode: 'nano' },
          (res) => {
            void chrome.runtime.lastError;
            if (res && res.status === 'nano_unavailable') {
              renderStatusToast('nano_unavailable', res.reason);
              return;
            }
            isTranscribing = true;
            transcriptionStartedAt = (res && res.startTime) || Date.now();
            sawCaptionsActive = areCaptionsVisible();
            captionsOffDismissed = false;
            ensureCaptionsEnabled();
            startObserving();
            renderStatusToast('capturing_started');
          }
        );
      });

      const dismissBtn = document.createElement('button');
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.style.cssText =
        'background: transparent; color: #5f6368; border: 1px solid #dadce0; border-radius: 4px; padding: 5px 10px; font-size: 11.5px; cursor: pointer;';
      dismissBtn.addEventListener('click', () => {
        removeStatusToast();
      });

      actionsRow.appendChild(useNanoBtn);
      actionsRow.appendChild(dismissBtn);
      toast.appendChild(actionsRow);
    } else if (state === 'nano_unavailable') {
      toast.style.borderLeftColor = '#d9534f';
      const reason = errorMessage || 'unknown';
      if (reason === 'setting_off') {
        messageEl.textContent = 'mast: On-Device AI is turned off.';
      } else if (reason === 'low_disk') {
        messageEl.textContent = 'mast: Not enough disk space.';
      } else {
        messageEl.textContent = 'mast: Gemini On-Device is unavailable.';
      }
      toast.appendChild(messageEl);

      const fixEl = document.createElement('div');
      fixEl.style.cssText = 'font-size: 11.5px; color: #5f6368; line-height: 1.4;';
      if (reason === 'setting_off') {
        fixEl.textContent = 'Turn on On-device AI in Chrome System Settings, or switch models in Settings.';
      } else if (reason === 'low_disk') {
        fixEl.textContent = 'At least 22 GB of free disk space is required, or switch models in Settings.';
      } else {
        fixEl.textContent = 'Turn on On-device AI in Chrome System Settings and ensure 22 GB free disk space.';
      }
      toast.appendChild(fixEl);

      const actionsRow = document.createElement('div');
      actionsRow.style.cssText = 'display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap;';

      if (reason === 'setting_off' || reason === 'unknown') {
        const sysBtn = document.createElement('button');
        sysBtn.textContent = 'Open System Settings';
        sysBtn.style.cssText =
          'background: #5B5FC7; color: #fff; border: none; border-radius: 4px; padding: 5px 10px; font-size: 11.5px; cursor: pointer; font-weight: 500;';
        sysBtn.addEventListener('click', () => {
          chrome.runtime.sendMessage({ action: 'open_chrome_url', url: 'chrome://settings/system' });
        });
        actionsRow.appendChild(sysBtn);
      }

      const settingsBtn = document.createElement('button');
      settingsBtn.textContent = 'Settings';
      settingsBtn.style.cssText =
        reason === 'setting_off' || reason === 'unknown'
          ? 'background: #ffffff; color: #5B5FC7; border: 1px solid #5B5FC7; border-radius: 4px; padding: 5px 10px; font-size: 11.5px; cursor: pointer; font-weight: 500;'
          : 'background: #5B5FC7; color: #fff; border: none; border-radius: 4px; padding: 5px 10px; font-size: 11.5px; cursor: pointer; font-weight: 500;';
      settingsBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'open_options' });
      });

      const dismissBtn = document.createElement('button');
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.style.cssText =
        'background: transparent; color: #5f6368; border: 1px solid #dadce0; border-radius: 4px; padding: 5px 10px; font-size: 11.5px; cursor: pointer;';
      dismissBtn.addEventListener('click', () => {
        removeStatusToast();
      });

      actionsRow.appendChild(settingsBtn);
      actionsRow.appendChild(dismissBtn);
      toast.appendChild(actionsRow);
    } else if (state === 'generating') {
      toast.style.borderLeftColor = '#5B5FC7';
      messageEl.textContent = 'mast: Transcript saved. Generating AI notes...';
      toast.appendChild(messageEl);

      const barTrack = document.createElement('div');
      barTrack.style.cssText =
        'width: 100%; height: 6px; background: #e8eaed; border-radius: 999px; overflow: hidden; margin-top: 2px;';

      const barFill = document.createElement('div');
      barFill.id = 'mast-toast-progress-fill';
      barFill.style.cssText =
        'height: 100%; width: 5%; background: linear-gradient(90deg, #5B5FC7 0%, #7b7fe0 100%); border-radius: 999px; transition: width 0.3s ease;';
      barTrack.appendChild(barFill);
      toast.appendChild(barTrack);

      const stageRow = document.createElement('div');
      stageRow.id = 'mast-toast-progress-label';
      stageRow.style.cssText =
        'display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 11.5px; color: #5f6368;';
      stageRow.innerHTML = '<span>Preparing meeting notes...</span><strong style="color: #5B5FC7;">5%</strong>';
      toast.appendChild(stageRow);

      try {
        chrome.storage.local.get(['notesProgress', 'notesStage'], (s) => {
          if (chrome.runtime.lastError || !s) return;
          updateToastProgressUI(s.notesProgress, s.notesStage);
        });
      } catch (_) {}
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
      actionsRow.style.cssText = 'display: flex; gap: 8px; margin-top: 4px; flex-wrap: wrap;';

      const retryBtn = document.createElement('button');
      retryBtn.textContent = 'Retry';
      retryBtn.style.cssText =
        'background: #5B5FC7; color: #fff; border: none; border-radius: 4px; padding: 5px 10px; font-size: 12px; cursor: pointer; font-weight: 500;';
      retryBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'generate_notes' });
      });
      actionsRow.appendChild(retryBtn);

      if (errorMessage && /on-device/i.test(errorMessage)) {
        const settingsBtn = document.createElement('button');
        settingsBtn.textContent = 'Settings';
        settingsBtn.style.cssText =
          'background: #ffffff; color: #5B5FC7; border: 1px solid #5B5FC7; border-radius: 4px; padding: 5px 10px; font-size: 12px; cursor: pointer; font-weight: 500;';
        settingsBtn.addEventListener('click', () => {
          chrome.runtime.sendMessage({ action: 'open_options' });
        });
        actionsRow.appendChild(settingsBtn);
      }

      const dismissBtn = document.createElement('button');
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.style.cssText =
        'background: transparent; color: #5f6368; border: 1px solid #dadce0; border-radius: 4px; padding: 5px 10px; font-size: 12px; cursor: pointer;';
      dismissBtn.addEventListener('click', () => {
        shouldGuardUnload = false;
        removeStatusToast();
      });

      actionsRow.appendChild(dismissBtn);
      toast.appendChild(actionsRow);
    } else if (state === 'captions_off') {
      toast.style.borderLeftColor = '#d9534f';
      messageEl.textContent = 'mast: Live captions are off. Enable captions to continue capturing.';
      toast.appendChild(messageEl);

      const actionsRow = document.createElement('div');
      actionsRow.style.cssText = 'display: flex; gap: 8px; margin-top: 4px;';

      const enableBtn = document.createElement('button');
      enableBtn.textContent = 'Enable Captions';
      enableBtn.style.cssText =
        'background: #5B5FC7; color: #fff; border: none; border-radius: 4px; padding: 5px 10px; font-size: 12px; cursor: pointer; font-weight: 500;';
      enableBtn.addEventListener('click', () => {
        ensureCaptionsEnabled();
      });

      const dismissBtn = document.createElement('button');
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.style.cssText =
        'background: transparent; color: #5f6368; border: 1px solid #dadce0; border-radius: 4px; padding: 5px 10px; font-size: 12px; cursor: pointer;';
      dismissBtn.addEventListener('click', () => {
        captionsOffDismissed = true;
        removeStatusToast();
      });

      actionsRow.appendChild(enableBtn);
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
      syncTranscriptToRecentMeetings(transcriptLines, true);
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
    if (currentToastState === 'captions_off' || currentToastState === 'capturing_started') {
      removeStatusToast();
    }
    sawActiveMeeting = false;
    missingCallChecks = 0;
    sawCaptionsActive = false;
    captionsOffDismissed = false;
    transcriptionStartedAt = 0;
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

        const captionsVisible = areCaptionsVisible();
        try {
          chrome.storage.local.set({ liveCaptionsOn: captionsVisible });
        } catch (_) {}

        if (captionsVisible) {
          sawCaptionsActive = true;
          captionsOffDismissed = false;
          if (currentToastState === 'captions_off') {
            removeStatusToast();
          }
        } else if (sawCaptionsActive || (transcriptionStartedAt && Date.now() - transcriptionStartedAt >= 6000)) {
          if (!captionsOffDismissed && currentToastState !== 'captions_off') {
            renderStatusToast('captions_off');
          }
        }
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
            const speakerEl = node.matches(SPEAKER_SELECTOR) ? node : node.querySelector(SPEAKER_SELECTOR);
            if (speakerEl && speakerEl.innerText && speakerEl.innerText.trim()) {
              currentSpeaker = speakerEl.innerText.trim();
              console.log("mast: Found speaker:", currentSpeaker);
            }

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
        if (transcriptLines.length > 0) {
          chrome.storage.local.set({ savedTranscript: transcriptLines, liveCaptionsOn: true });
          syncTranscriptToRecentMeetings(transcriptLines, false);
        }
      }
    });

    observer.observe(targetNode, { childList: true, subtree: true, characterData: true });
    startCallEndPolling();
  }

  function areCaptionsVisibleLocal() {
    for (let [textEl] of captionsMap.entries()) {
      if (document.body && document.body.contains(textEl)) {
        return true;
      }
    }
    const captionSelectors = [
      CAPTION_CONTAINER_SELECTOR,
      TEXT_SELECTOR,
      SPEAKER_SELECTOR,
      '[data-tid="closed-captions-container"]',
      '[data-tid="closed-caption-renderer-wrapper"]',
      '[data-tid="closed-caption-text"]',
      '.ui-captions-container',
      '[data-tid*="closed-caption" i]',
      '[data-tid*="captions-container" i]',
      '[data-tid*="caption-renderer" i]',
      '[aria-label*="Live captions" i]',
      '[aria-label*="Closed captions" i]'
    ];
    return captionSelectors.some((sel) => {
      try {
        return !!document.querySelector(sel);
      } catch (_) {
        return false;
      }
    });
  }

  function areCaptionsVisible() {
    if (areCaptionsVisibleLocal()) return true;
    if (window === window.top && Date.now() - lastChildFrameCaptionsAt < 4500) {
      return true;
    }
    return false;
  }

  function ensureCaptionsEnabled() {
    if (areCaptionsVisibleLocal()) {
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

  function startMeetingDetectionLoop() {
    if (meetingDetectInterval) clearInterval(meetingDetectInterval);

    const checkMeetingPresence = () => {
      try {
        const localActive = isTeamsMeetingActiveLocal();
        if (window !== window.top) {
          if (localActive) {
            window.top.postMessage(
              {
                type: 'MAST_FRAME_MEETING_STATUS',
                active: true,
                captionsVisible: areCaptionsVisibleLocal(),
                title: extractTeamsMeetingTitle()
              },
              '*'
            );
          }
          return;
        }

        const meetingActive = isTeamsMeetingActive();
        if (!meetingActive) {
          meetingDetectedToastDismissed = false;
          if (currentToastState === 'meeting_detected') {
            removeStatusToast();
          }
          return;
        }

        syncMeetingTitleToStorage();

        if (isTranscribing) {
          if (currentToastState === 'meeting_detected') {
            removeStatusToast();
          }
          return;
        }

        chrome.storage.local.get(['isTranscribing', 'notesStatus'], (res) => {
          if (chrome.runtime.lastError) return;
          if (res.isTranscribing) {
            if (currentToastState === 'meeting_detected') {
              removeStatusToast();
            }
            return;
          }
          if (res.notesStatus === 'generating') return;
          if (meetingDetectedToastDismissed) return;
          if (
            currentToastState !== 'meeting_detected' &&
            currentToastState !== 'choose_mode' &&
            currentToastState !== 'capturing_started' &&
            currentToastState !== 'api_key_needed' &&
            currentToastState !== 'nano_unavailable' &&
            currentToastState !== 'generating' &&
            currentToastState !== 'done' &&
            currentToastState !== 'error'
          ) {
            renderStatusToast('meeting_detected');
          }
        });
      } catch (_) {}
    };

    checkMeetingPresence();
    meetingDetectInterval = setInterval(checkMeetingPresence, 2000);
  }

  // React to background generation and transcription status updates
  function onStorageChanged(changes, area) {
    if (area !== 'local') return;

    if (changes.isTranscribing) {
      if (changes.isTranscribing.newValue === true && currentToastState === 'meeting_detected') {
        removeStatusToast();
      } else if (changes.isTranscribing.newValue === false) {
        meetingDetectedToastDismissed = true;
      }
    }

    if ((changes.notesProgress || changes.notesStage) && currentToastState === 'generating') {
      chrome.storage.local.get(['notesProgress', 'notesStage'], (s) => {
        if (!chrome.runtime.lastError && s) {
          updateToastProgressUI(s.notesProgress, s.notesStage);
        }
      });
    }

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
        if (currentToastState !== 'meeting_detected') {
          removeStatusToast();
        }
      }
    }
  }
  chrome.storage.onChanged.addListener(onStorageChanged);

  function onRuntimeMessage(request, sender, sendResponse) {
    if (request.action === "get_status") {
      if (window === window.top || isTeamsMeetingActiveLocal()) {
        sendResponse({
          captionsOn: areCaptionsVisible(),
          inActiveCall: isTeamsMeetingActive(),
          meetingTitle: extractTeamsMeetingTitle()
        });
      }
      return false;
    } else if (request.action === "start") {
      shouldGuardUnload = false;
      if (currentToastState !== 'capturing_started') {
        removeStatusToast();
      }
      isTranscribing = true;
      transcriptionStartedAt = Date.now();
      sawCaptionsActive = areCaptionsVisible();
      captionsOffDismissed = false;
      ensureCaptionsEnabled();
      startObserving();
      sendResponse({ status: "started" });
    } else if (request.action === "stop") {
      meetingDetectedToastDismissed = true;
      stopLocalObservation();
      sendResponse({ status: "stopped" });
    } else if (request.action === "force_captions") {
      ensureCaptionsEnabled();
      sendResponse({ status: "force_captions_sent" });
    }
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  window.__mastContentScriptCleanup = function () {
    if (meetingDetectInterval) clearInterval(meetingDetectInterval);
    if (callCheckInterval) clearInterval(callCheckInterval);
    if (issueTimer) clearTimeout(issueTimer);
    if (statusToastTimer) clearTimeout(statusToastTimer);
    if (observer) observer.disconnect();
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('message', onWindowMessage);
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch (_) {}
  };

  startMeetingDetectionLoop();
})();
