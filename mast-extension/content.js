(function () {
  const CONTENT_SCRIPT_VERSION = '2.9-dev-7';

  function isExtensionContextValid() {
    try {
      return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  if (window.__mastContentScriptVersion === CONTENT_SCRIPT_VERSION && isExtensionContextValid()) {
    return;
  }
  if (typeof window.__mastContentScriptCleanup === 'function') {
    try {
      window.__mastContentScriptCleanup();
    } catch (_) {}
  }
  try {
    document.dispatchEvent(new CustomEvent('__mast_cleanup_previous_instance'));
  } catch (_) {}
  ['mast-status-toast', 'mast-captions-alert', 'mast-captions-alert-style', 'mast-pill-style', 'mast-hide-captions-style'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });

  window.__mastContentScriptVersion = CONTENT_SCRIPT_VERSION;
  window.__mastContentScriptLoaded = true;

  function onCrossWorldCleanup() {
    if (typeof window.__mastContentScriptCleanup === 'function') {
      try {
        window.__mastContentScriptCleanup();
      } catch (_) {}
    }
  }
  document.addEventListener('__mast_cleanup_previous_instance', onCrossWorldCleanup);

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
  let pillTimerInterval = null;
  let lastReportedInActiveCall = null;
  let sawActiveMeeting = false;
  let missingCallChecks = 0;
  let shouldGuardUnload = false;
  let statusToastTimer = null;
  let currentToastState = null;
  let sawCaptionsActive = false;
  let captionsOffDismissed = false;
  let captionsAlertTimer = null;
  let captionsAlertMode = null;
  let captionsAlertMinimized = false;
  let capturingPillMinimized = false;
  let customPillPos = null;
  let didJustDragPill = false;
  let hideCaptionBox = false;
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
    const data = e && e.data;
    if (!data) return;
    if (data.type === 'MAST_ENABLE_CAPTIONS') {
      ensureCaptionsEnabled();
      return;
    }
    if (data.type === 'MAST_STOP_OBSERVATION') {
      meetingDetectedToastDismissed = true;
      stopLocalObservation();
      return;
    }
    if (window !== window.top) return;
    if (data.type !== 'MAST_FRAME_MEETING_STATUS') return;
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

  function removeHideCaptionsStyle() {
    const existing = document.getElementById('mast-hide-captions-style');
    if (existing) {
      existing.remove();
    }
  }

  function syncHideCaptionsStyle() {
    if (isTranscribing && hideCaptionBox) {
      let styleEl = document.getElementById('mast-hide-captions-style');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'mast-hide-captions-style';
        styleEl.textContent = `
          [data-tid="closed-caption-renderer-wrapper"],
          [data-tid="closed-captions-container"],
          .ui-captions-container,
          [data-tid*="closed-captions-container" i] {
            opacity: 0.001 !important;
            max-height: 1px !important;
            min-height: 0 !important;
            height: 1px !important;
            padding: 0 !important;
            margin: 0 !important;
            border: none !important;
            overflow: hidden !important;
            pointer-events: none !important;
          }
        `;
        (document.head || document.documentElement).appendChild(styleEl);
      }
    } else {
      removeHideCaptionsStyle();
    }
  }

  function ensureDynamicPillStyles() {
    if (document.getElementById('mast-pill-style')) return;
    const styleEl = document.createElement('style');
    styleEl.id = 'mast-pill-style';
    styleEl.textContent = `
      @keyframes mastSlideInTop {
        from { opacity: 0; transform: translate(-50%, -10px) scale(0.96); }
        to { opacity: 1; transform: translate(-50%, 0) scale(1); }
      }
      @keyframes mastWaveBar {
        0%, 100% { transform: scaleY(0.38); opacity: 0.75; }
        50% { transform: scaleY(1); opacity: 1; }
      }
      @keyframes mastAmberPulse {
        0%, 100% { transform: scale(1); filter: drop-shadow(0 0 0 rgba(255, 159, 10, 0)); }
        50% { transform: scale(1.08); filter: drop-shadow(0 0 5px rgba(255, 159, 10, 0.55)); }
      }
      @keyframes mastSpinRing {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      #mast-status-toast {
        position: fixed;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        max-width: min(94vw, 660px);
        z-index: 2147483647;
        background: linear-gradient(180deg, rgba(44, 44, 48, 0.96) 0%, rgba(28, 28, 32, 0.96) 100%);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        color: #ffffff;
        border: 1px solid rgba(255, 255, 255, 0.24);
        border-radius: 999px;
        box-shadow:
          0 0 0 1px rgba(0, 0, 0, 0.7),
          inset 0 1px 0 rgba(255, 255, 255, 0.18),
          0 12px 32px rgba(0, 0, 0, 0.55),
          0 2px 8px rgba(0, 0, 0, 0.35);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        line-height: 1.35;
        display: inline-flex;
        align-items: center;
        gap: 12px;
        padding: 9px 14px 9px 16px;
        white-space: nowrap;
        user-select: none;
        cursor: grab;
        box-sizing: border-box;
        animation: mastSlideInTop 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        transition: background 0.2s ease, border-color 0.2s ease, padding 0.2s ease, box-shadow 0.2s ease;
      }
      #mast-status-toast[data-dragging="true"] {
        cursor: grabbing !important;
        transition: none !important;
      }
      #mast-status-toast[data-tone="indigo"] {
        border-color: rgba(139, 143, 248, 0.48);
        box-shadow:
          0 0 0 1px rgba(0, 0, 0, 0.7),
          inset 0 1px 0 rgba(255, 255, 255, 0.18),
          0 12px 32px rgba(0, 0, 0, 0.55),
          0 0 16px rgba(139, 143, 248, 0.16);
      }
      #mast-status-toast[data-tone="green"] {
        border-color: rgba(48, 209, 88, 0.48);
        box-shadow:
          0 0 0 1px rgba(0, 0, 0, 0.7),
          inset 0 1px 0 rgba(255, 255, 255, 0.18),
          0 12px 32px rgba(0, 0, 0, 0.55),
          0 0 16px rgba(48, 209, 88, 0.16);
      }
      #mast-status-toast[data-tone="amber"] {
        border-color: rgba(255, 159, 10, 0.62);
        box-shadow:
          0 0 0 1px rgba(0, 0, 0, 0.7),
          inset 0 1px 0 rgba(255, 255, 255, 0.18),
          0 12px 32px rgba(0, 0, 0, 0.55),
          0 0 18px rgba(255, 159, 10, 0.22);
      }
      #mast-status-toast[data-tone="red"] {
        border-color: rgba(255, 69, 58, 0.62);
        box-shadow:
          0 0 0 1px rgba(0, 0, 0, 0.7),
          inset 0 1px 0 rgba(255, 255, 255, 0.18),
          0 12px 32px rgba(0, 0, 0, 0.55),
          0 0 18px rgba(255, 69, 58, 0.22);
      }
      #mast-status-toast[data-mode="micro"] {
        padding: 7px 15px;
        gap: 8px;
        cursor: pointer;
        font-size: 13px;
      }
      #mast-status-toast[data-mode="micro"]:hover,
      #mast-status-toast[data-mode="badge"]:hover {
        background: linear-gradient(180deg, rgba(56, 56, 62, 0.98) 0%, rgba(36, 36, 40, 0.98) 100%);
        border-color: rgba(255, 255, 255, 0.42);
      }
      #mast-status-toast[data-mode="badge"] {
        padding: 8px 16px;
        gap: 10px;
        cursor: pointer;
        font-size: 12.5px;
      }
      #mast-status-toast[data-mode="restored"] {
        padding: 8px 16px;
        gap: 10px;
      }
      .mast-pill-brand {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        font-weight: 700;
        font-size: 13px;
        letter-spacing: -0.02em;
        color: #ffffff;
        flex-shrink: 0;
      }
      .mast-pill-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        flex-shrink: 0;
      }
      .mast-wave-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 2px;
        width: 14px;
        height: 14px;
      }
      .mast-wave-bar {
        width: 2.5px;
        height: 12px;
        background: #30D158;
        border-radius: 2px;
        transform-origin: center;
        animation: mastWaveBar 1.1s infinite ease-in-out;
      }
      .mast-wave-bar-1 { animation-delay: 0s; }
      .mast-wave-bar-2 { animation-delay: 0.22s; }
      .mast-wave-bar-3 { animation-delay: 0.44s; }
      .mast-pause-svg {
        animation: mastAmberPulse 2s infinite ease-in-out;
      }
      .mast-spin-svg {
        animation: mastSpinRing 0.95s linear infinite;
      }
      .mast-pill-sep {
        width: 1px;
        height: 15px;
        background: rgba(255, 255, 255, 0.18);
        flex-shrink: 0;
      }
      .mast-pill-text {
        font-weight: 500;
        letter-spacing: -0.01em;
        color: rgba(255, 255, 255, 0.95);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .mast-pill-timer {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        font-size: 12px;
        color: #a5a9ff;
        background: rgba(139, 143, 248, 0.14);
        border: 1px solid rgba(139, 143, 248, 0.26);
        padding: 2px 8px;
        border-radius: 999px;
        letter-spacing: 0.02em;
        flex-shrink: 0;
      }
      #mast-status-toast[data-mode="micro"] .mast-pill-timer {
        padding: 1px 7px;
        font-size: 11.5px;
      }
      .mast-pill-actions {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }
      .mast-pill-btn-primary {
        background: #5B5FC7;
        color: #ffffff;
        border: none;
        border-radius: 999px;
        padding: 6px 13px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
        line-height: 1.2;
        transition: background 0.15s ease, transform 0.1s ease;
      }
      .mast-pill-btn-primary:hover {
        background: #6b6fd6;
      }
      .mast-pill-btn-primary:active {
        transform: scale(0.97);
      }
      .mast-pill-btn-primary:disabled {
        opacity: 0.7;
        cursor: default;
      }
      .mast-pill-btn-amber {
        background: #FF9F0A;
        color: #1c1c1e;
        border: none;
        border-radius: 999px;
        padding: 6px 13px;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
        font-family: inherit;
        line-height: 1.2;
        transition: background 0.15s ease, transform 0.1s ease;
      }
      .mast-pill-btn-amber:hover {
        background: #ffb340;
      }
      .mast-pill-btn-amber:active {
        transform: scale(0.97);
      }
      .mast-pill-btn-subtle {
        background: rgba(255, 255, 255, 0.12);
        color: #ffffff;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 999px;
        padding: 5px 12px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
        line-height: 1.2;
        transition: background 0.15s ease, border-color 0.15s ease;
      }
      .mast-pill-btn-subtle:hover {
        background: rgba(255, 255, 255, 0.2);
        border-color: rgba(255, 255, 255, 0.32);
      }
      .mast-pill-btn-stop {
        background: rgba(255, 69, 58, 0.18);
        color: #ff6961;
        border: 1px solid rgba(255, 69, 58, 0.38);
        border-radius: 999px;
        padding: 5px 12px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
        line-height: 1.2;
        transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
      }
      .mast-pill-btn-stop:hover {
        background: rgba(255, 69, 58, 0.3);
        border-color: rgba(255, 69, 58, 0.55);
        color: #ffffff;
      }
      .mast-pill-btn-icon {
        background: rgba(255, 255, 255, 0.12);
        color: rgba(255, 255, 255, 0.82);
        border: none;
        border-radius: 50%;
        width: 25px;
        height: 25px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        font-weight: 600;
        line-height: 1;
        cursor: pointer;
        padding: 0;
        flex-shrink: 0;
        transition: background 0.15s ease, color 0.15s ease;
      }
      .mast-pill-btn-icon:hover {
        background: rgba(255, 255, 255, 0.24);
        color: #ffffff;
      }
      .mast-pill-progress-wrap {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        min-width: 210px;
        max-width: 340px;
      }
      .mast-pill-progress-track {
        width: 72px;
        height: 5px;
        background: rgba(255, 255, 255, 0.18);
        border-radius: 999px;
        overflow: hidden;
        flex-shrink: 0;
      }
    `;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  function createPillIconEl(iconType) {
    const wrap = document.createElement('span');
    wrap.className = 'mast-pill-icon';
    wrap.setAttribute('data-icon', iconType);
    if (iconType === 'waveform') {
      wrap.innerHTML =
        '<span class="mast-wave-icon" aria-hidden="true">' +
        '<span class="mast-wave-bar mast-wave-bar-1"></span>' +
        '<span class="mast-wave-bar mast-wave-bar-2"></span>' +
        '<span class="mast-wave-bar mast-wave-bar-3"></span>' +
        '</span>';
    } else if (iconType === 'pause_amber') {
      wrap.innerHTML =
        '<svg class="mast-pause-svg" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<circle cx="8" cy="8" r="7" fill="rgba(255, 159, 10, 0.18)" stroke="#FF9F0A" stroke-width="1.4"/>' +
        '<rect x="5.3" y="5" width="1.8" height="6" rx="0.8" fill="#FF9F0A"/>' +
        '<rect x="8.9" y="5" width="1.8" height="6" rx="0.8" fill="#FF9F0A"/>' +
        '</svg>';
    } else if (iconType === 'warning_amber') {
      wrap.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M8 2L14.5 13.5H1.5L8 2Z" fill="rgba(255, 159, 10, 0.18)" stroke="#FF9F0A" stroke-width="1.4" stroke-linejoin="round"/>' +
        '<rect x="7.3" y="6" width="1.4" height="4" rx="0.7" fill="#FF9F0A"/>' +
        '<circle cx="8" cy="11.6" r="0.8" fill="#FF9F0A"/>' +
        '</svg>';
    } else if (iconType === 'spinner') {
      wrap.innerHTML =
        '<svg class="mast-spin-svg" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<circle cx="8" cy="8" r="6" stroke="rgba(139, 143, 248, 0.25)" stroke-width="2"/>' +
        '<path d="M14 8A6 6 0 0 0 8 2" stroke="#8B8FF8" stroke-width="2" stroke-linecap="round"/>' +
        '</svg>';
    } else if (iconType === 'check_green') {
      wrap.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<circle cx="8" cy="8" r="7" fill="rgba(48, 209, 88, 0.18)" stroke="#30D158" stroke-width="1.4"/>' +
        '<path d="M5 8.2L7.1 10.3L11.2 6" stroke="#30D158" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>';
    } else if (iconType === 'error_red') {
      wrap.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<circle cx="8" cy="8" r="7" fill="rgba(255, 69, 58, 0.18)" stroke="#FF453A" stroke-width="1.4"/>' +
        '<rect x="7.25" y="4.5" width="1.5" height="4.5" rx="0.75" fill="#FF453A"/>' +
        '<circle cx="8" cy="11.2" r="0.85" fill="#FF453A"/>' +
        '</svg>';
    } else {
      wrap.innerHTML =
        '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M8 1.5L9.65 6.35L14.5 8L9.65 9.65L8 14.5L6.35 9.65L1.5 8L6.35 6.35L8 1.5Z" fill="#8B8FF8"/>' +
        '</svg>';
    }
    return wrap;
  }

  function clampAndApplyPillPosition(toast) {
    if (!toast) return;
    if (!customPillPos) {
      toast.style.left = '50%';
      toast.style.top = '16px';
      toast.style.transform = 'translateX(-50%)';
      return;
    }
    const vw = window.innerWidth || document.documentElement.clientWidth || 1024;
    const vh = window.innerHeight || document.documentElement.clientHeight || 768;
    const rect = toast.getBoundingClientRect();
    const halfW = Math.max(24, (rect.width || 120) / 2);
    const height = Math.max(28, rect.height || 38);
    const margin = 8;

    const clampedCenterX = Math.max(halfW + margin, Math.min(vw - halfW - margin, customPillPos.centerX));
    const clampedTopY = Math.max(margin, Math.min(vh - height - margin, customPillPos.topY));

    toast.style.left = `${Math.round(clampedCenterX)}px`;
    toast.style.top = `${Math.round(clampedTopY)}px`;
    toast.style.transform = 'translateX(-50%)';
  }

  function scheduleCapturingAutoShrink() {
    if (statusToastTimer) {
      clearTimeout(statusToastTimer);
      statusToastTimer = null;
    }
    statusToastTimer = setTimeout(() => {
      if (currentToastState === 'capturing_started') {
        if (isTranscribing) {
          renderStatusToast('capturing_badge');
        } else {
          removeStatusToast();
        }
      }
    }, 9000);
  }

  function ensurePillDraggable(toast) {
    if (!toast || toast.__mastDragBound) return;
    toast.__mastDragBound = true;

    toast.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target && typeof e.target.closest === 'function' && e.target.closest('button')) {
        return;
      }
      const rect = toast.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const initCenterX = rect.left + rect.width / 2;
      const initTopY = rect.top;
      let moved = false;
      didJustDragPill = false;

      const onMouseMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (!moved && Math.hypot(dx, dy) > 4) {
          moved = true;
          didJustDragPill = true;
          toast.setAttribute('data-dragging', 'true');
          if (statusToastTimer && currentToastState === 'capturing_started') {
            clearTimeout(statusToastTimer);
            statusToastTimer = null;
          }
        }
        if (moved) {
          moveEvent.preventDefault();
          customPillPos = {
            centerX: initCenterX + dx,
            topY: initTopY + dy
          };
          clampAndApplyPillPosition(toast);
        }
      };

      const onMouseUp = () => {
        window.removeEventListener('mousemove', onMouseMove, true);
        window.removeEventListener('mouseup', onMouseUp, true);
        if (moved) {
          toast.removeAttribute('data-dragging');
          if (currentToastState === 'capturing_started') {
            scheduleCapturingAutoShrink();
          }
          setTimeout(() => {
            didJustDragPill = false;
          }, 60);
        }
      };

      window.addEventListener('mousemove', onMouseMove, true);
      window.addEventListener('mouseup', onMouseUp, true);
    });
  }

  function onWindowResize() {
    if (!customPillPos) return;
    const toast = document.getElementById('mast-status-toast');
    if (toast) {
      clampAndApplyPillPosition(toast);
    }
  }
  window.addEventListener('resize', onWindowResize);

  function handlePillStopClick(e) {
    if (e) e.stopPropagation();
    if (!isExtensionContextValid()) {
      removeStatusToast();
      return;
    }
    meetingDetectedToastDismissed = true;
    try {
      if (window === window.top && window.frames) {
        for (let i = 0; i < window.frames.length; i++) {
          try {
            window.frames[i].postMessage({ type: 'MAST_STOP_OBSERVATION' }, '*');
          } catch (_) {}
        }
      }
    } catch (_) {}
    stopLocalObservation();

    setTimeout(() => {
      try {
        chrome.storage.local.get(['savedTranscript', 'activeTabId'], (stored) => {
          if (chrome.runtime.lastError) return;
          const hasLines = Array.isArray(stored && stored.savedTranscript) && stored.savedTranscript.length > 0;
          if (hasLines) {
            chrome.storage.local.set(
              {
                isTranscribing: false,
                notesStatus: 'generating',
                notesProgress: 5,
                notesStage: 'Connecting to Gemini...',
                generationStartedAt: Date.now()
              },
              () => {
                chrome.runtime.sendMessage(
                  { action: 'stop_and_finalize', tabId: (stored && stored.activeTabId) || null },
                  () => {
                    void chrome.runtime.lastError;
                  }
                );
              }
            );
          } else {
            chrome.storage.local.set(
              {
                isTranscribing: false,
                notesStatus: 'idle',
                notesError: '',
                notesProgress: 0,
                notesStage: ''
              },
              () => {
                removeStatusToast();
              }
            );
          }
        });
      } catch (_) {}
    }, 80);
  }

  function createPillBrandEl(iconType, brandText = 'mast') {
    const brand = document.createElement('span');
    brand.className = 'mast-pill-brand';
    brand.appendChild(createPillIconEl(iconType));
    const label = document.createElement('span');
    label.textContent = brandText;
    brand.appendChild(label);
    return brand;
  }

  function createPillSepEl() {
    const sep = document.createElement('span');
    sep.className = 'mast-pill-sep';
    return sep;
  }

  function formatPillElapsed(startTime) {
    const base = startTime || transcriptionStartedAt || Date.now();
    const totalSec = Math.max(0, Math.floor((Date.now() - base) / 1000));
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60).toString().padStart(2, '0');
    const secs = (totalSec % 60).toString().padStart(2, '0');
    return hrs > 0 ? `${hrs}:${mins}:${secs}` : `${mins}:${secs}`;
  }

  function createPillTimerEl() {
    const timerSpan = document.createElement('span');
    timerSpan.id = 'mast-pill-timer';
    timerSpan.className = 'mast-pill-timer';
    timerSpan.textContent = formatPillElapsed(transcriptionStartedAt);
    return timerSpan;
  }

  function startPillTimer() {
    if (pillTimerInterval) clearInterval(pillTimerInterval);
    pillTimerInterval = setInterval(() => {
      if (!isTranscribing) {
        clearInterval(pillTimerInterval);
        pillTimerInterval = null;
        return;
      }
      const el = document.getElementById('mast-pill-timer');
      if (el) {
        el.textContent = formatPillElapsed(transcriptionStartedAt);
      }
    }, 1000);
  }

  function stopPillTimer() {
    if (pillTimerInterval) {
      clearInterval(pillTimerInterval);
      pillTimerInterval = null;
    }
  }

  function removeCaptionsAlert() {
    if (captionsAlertTimer) {
      clearTimeout(captionsAlertTimer);
      captionsAlertTimer = null;
    }
    captionsAlertMode = null;
    const legacyAlert = document.getElementById('mast-captions-alert');
    if (legacyAlert) {
      legacyAlert.remove();
    }
    if (
      currentToastState === 'captions_off' ||
      currentToastState === 'captions_off_badge' ||
      currentToastState === 'restored'
    ) {
      removeStatusToast();
    }
  }

  function triggerEnableCaptionsAllFrames() {
    ensureCaptionsEnabled();
    try {
      if (window === window.top && window.frames) {
        for (let i = 0; i < window.frames.length; i++) {
          try {
            window.frames[i].postMessage({ type: 'MAST_ENABLE_CAPTIONS' }, '*');
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  function renderCaptionsAlert(mode = 'alert') {
    if (window !== window.top || !document.body) return;
    if (mode === 'badge') {
      renderStatusToast('captions_off_badge');
    } else if (mode === 'restored') {
      renderStatusToast('restored');
    } else {
      renderStatusToast('captions_off');
    }
  }

  function removeStatusToast() {
    if (statusToastTimer) {
      clearTimeout(statusToastTimer);
      statusToastTimer = null;
    }
    if (captionsAlertTimer) {
      clearTimeout(captionsAlertTimer);
      captionsAlertTimer = null;
    }
    currentToastState = null;
    captionsAlertMode = null;
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
    pctEl.style.cssText = 'color: #a5a9ff; flex-shrink: 0; margin-left: 6px;';
    pctEl.textContent = `${pct}%`;
    label.appendChild(stageSpan);
    label.appendChild(pctEl);
  }

  function renderStatusToast(state, errorMessage) {
    if (window !== window.top || !document.body) return;

    if (statusToastTimer) {
      clearTimeout(statusToastTimer);
      statusToastTimer = null;
    }
    if (captionsAlertTimer) {
      clearTimeout(captionsAlertTimer);
      captionsAlertTimer = null;
    }

    if (state === 'captions_off' && captionsAlertMinimized) {
      state = 'captions_off_badge';
    }

    ensureDynamicPillStyles();
    currentToastState = state;
    if (state === 'captions_off') {
      captionsAlertMode = 'alert';
    } else if (state === 'captions_off_badge') {
      captionsAlertMode = 'badge';
    } else if (state === 'restored') {
      captionsAlertMode = 'restored';
    } else {
      captionsAlertMode = null;
    }

    let toast = document.getElementById('mast-status-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'mast-status-toast';
      document.body.appendChild(toast);
    }
    ensurePillDraggable(toast);

    toast.innerHTML = '';
    toast.onclick = null;
    toast.title = '';
    toast.setAttribute('data-state', state);
    toast.removeAttribute('data-mode');
    toast.removeAttribute('data-tone');

    if (state === 'meeting_detected') {
      toast.setAttribute('data-tone', 'indigo');
      toast.appendChild(createPillBrandEl('sparkle', 'mast'));
      toast.appendChild(createPillSepEl());

      const textEl = document.createElement('span');
      textEl.className = 'mast-pill-text';
      textEl.textContent = 'Teams meeting detected';
      toast.appendChild(textEl);

      const actionsRow = document.createElement('div');
      actionsRow.className = 'mast-pill-actions';

      const captureBtn = document.createElement('button');
      captureBtn.id = 'mast-toast-capture-btn';
      captureBtn.className = 'mast-pill-btn-primary';
      captureBtn.textContent = 'Capture Meeting Notes';
      captureBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!isExtensionContextValid()) {
          removeStatusToast();
          return;
        }
        captureBtn.disabled = true;
        captureBtn.textContent = 'Starting...';
        const title = extractTeamsMeetingTitle();

        let settled = false;
        const safetyTimer = setTimeout(() => {
          if (!settled && currentToastState === 'meeting_detected') {
            settled = true;
            renderStatusToast('api_key_needed');
          }
        }, 2500);

        try {
          chrome.storage.local.get(['apiKey'], (stored) => {
            if (settled) return;
            if (chrome.runtime.lastError) {
              settled = true;
              clearTimeout(safetyTimer);
              renderStatusToast('api_key_needed');
              return;
            }
            const hasKey = !!(stored && typeof stored.apiKey === 'string' && stored.apiKey.trim());
            if (!hasKey) {
              settled = true;
              clearTimeout(safetyTimer);
              renderStatusToast('api_key_needed');
              try {
                chrome.runtime.sendMessage({ action: 'open_options' }, () => {
                  void chrome.runtime.lastError;
                });
              } catch (_) {}
              return;
            }

            chrome.runtime.sendMessage({ action: 'start_from_toast', meetingTitle: title }, (res) => {
              if (settled) return;
              settled = true;
              clearTimeout(safetyTimer);
              void chrome.runtime.lastError;
              if (!res || res.status === 'no_api_key' || res.status === 'error') {
                renderStatusToast('api_key_needed');
                return;
              }
              isTranscribing = true;
              transcriptionStartedAt = (res && res.startTime) || Date.now();
              sawCaptionsActive = areCaptionsVisible();
              captionsOffDismissed = false;
              captionsAlertMinimized = false;
              capturingPillMinimized = false;
              syncHideCaptionsStyle();
              triggerEnableCaptionsAllFrames();
              startObserving();
              renderStatusToast('capturing_started');
            });
          });
        } catch (_) {
          settled = true;
          clearTimeout(safetyTimer);
          removeStatusToast();
        }
      });

      const dismissBtn = document.createElement('button');
      dismissBtn.id = 'mast-toast-dismiss-btn';
      dismissBtn.className = 'mast-pill-btn-icon';
      dismissBtn.title = 'Dismiss';
      dismissBtn.setAttribute('aria-label', 'Dismiss');
      dismissBtn.textContent = '\u00D7';
      dismissBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        meetingDetectedToastDismissed = true;
        removeStatusToast();
      });

      actionsRow.appendChild(captureBtn);
      actionsRow.appendChild(dismissBtn);
      toast.appendChild(actionsRow);
    } else if (state === 'capturing_started') {
      toast.setAttribute('data-tone', 'green');
      toast.appendChild(createPillBrandEl('waveform', 'mast'));
      toast.appendChild(createPillSepEl());

      const textEl = document.createElement('span');
      textEl.className = 'mast-pill-text';
      textEl.textContent = 'Capturing meeting notes';
      toast.appendChild(textEl);
      toast.appendChild(createPillTimerEl());
      startPillTimer();

      const actionsRow = document.createElement('div');
      actionsRow.className = 'mast-pill-actions';

      const hideBtn = document.createElement('button');
      hideBtn.id = 'mast-toast-hide-captions-btn';
      hideBtn.className = 'mast-pill-btn-subtle';
      hideBtn.textContent = hideCaptionBox ? 'Show Captions' : 'Hide Captions';
      hideBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        hideCaptionBox = !hideCaptionBox;
        hideBtn.textContent = hideCaptionBox ? 'Show Captions' : 'Hide Captions';
        syncHideCaptionsStyle();
        try {
          chrome.storage.local.set({ hideCaptionBox });
        } catch (_) {}
      });

      const stopBtn = document.createElement('button');
      stopBtn.id = 'mast-toast-stop-btn';
      stopBtn.className = 'mast-pill-btn-stop';
      stopBtn.textContent = 'Stop';
      stopBtn.addEventListener('click', handlePillStopClick);

      const minBtn = document.createElement('button');
      minBtn.id = 'mast-toast-minimize-btn';
      minBtn.className = 'mast-pill-btn-icon';
      minBtn.title = 'Collapse to micro-badge';
      minBtn.setAttribute('aria-label', 'Collapse to micro-badge');
      minBtn.textContent = '\u2013';
      minBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        capturingPillMinimized = true;
        renderStatusToast('capturing_badge');
      });

      actionsRow.appendChild(hideBtn);
      actionsRow.appendChild(stopBtn);
      actionsRow.appendChild(minBtn);
      toast.appendChild(actionsRow);

      scheduleCapturingAutoShrink();
    } else if (state === 'capturing_badge') {
      toast.setAttribute('data-tone', 'green');
      toast.setAttribute('data-mode', 'micro');
      toast.title = 'mast is capturing live captions \u2014 click to expand (drag to move)';
      toast.appendChild(createPillBrandEl('waveform', 'mast'));
      toast.appendChild(createPillTimerEl());
      startPillTimer();
      toast.onclick = () => {
        if (didJustDragPill) {
          didJustDragPill = false;
          return;
        }
        capturingPillMinimized = false;
        renderStatusToast('capturing_started');
      };
    } else if (state === 'captions_off') {
      toast.setAttribute('data-tone', 'amber');
      toast.setAttribute('data-mode', 'alert');
      toast.appendChild(createPillBrandEl('pause_amber', 'mast'));
      toast.appendChild(createPillSepEl());

      const textEl = document.createElement('span');
      textEl.className = 'mast-pill-text';
      textEl.textContent = 'Captions off \u2014 mast is paused';
      toast.appendChild(textEl);
      toast.appendChild(createPillTimerEl());
      startPillTimer();

      const actionsRow = document.createElement('div');
      actionsRow.className = 'mast-pill-actions';

      const enableBtn = document.createElement('button');
      enableBtn.id = 'mast-alert-enable-btn';
      enableBtn.className = 'mast-pill-btn-amber';
      enableBtn.textContent = 'Enable Captions';
      enableBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        enableBtn.textContent = 'Enabling...';
        triggerEnableCaptionsAllFrames();
        setTimeout(() => {
          if (currentToastState === 'captions_off' && document.body.contains(enableBtn)) {
            enableBtn.textContent = 'Enable Captions';
          }
        }, 1200);
      });

      const stopBtn = document.createElement('button');
      stopBtn.id = 'mast-toast-stop-btn';
      stopBtn.className = 'mast-pill-btn-stop';
      stopBtn.textContent = 'Stop';
      stopBtn.addEventListener('click', handlePillStopClick);

      const minBtn = document.createElement('button');
      minBtn.id = 'mast-alert-minimize-btn';
      minBtn.className = 'mast-pill-btn-icon';
      minBtn.title = 'Minimize to badge';
      minBtn.setAttribute('aria-label', 'Minimize to badge');
      minBtn.textContent = '\u2013';
      minBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        captionsAlertMinimized = true;
        renderStatusToast('captions_off_badge');
      });

      actionsRow.appendChild(enableBtn);
      actionsRow.appendChild(stopBtn);
      actionsRow.appendChild(minBtn);
      toast.appendChild(actionsRow);
    } else if (state === 'captions_off_badge') {
      toast.setAttribute('data-tone', 'amber');
      toast.setAttribute('data-mode', 'badge');
      toast.title = 'Click to re-enable live captions';
      toast.appendChild(createPillBrandEl('pause_amber', 'mast Paused'));

      const sep = document.createElement('span');
      sep.style.cssText = 'color: rgba(255, 255, 255, 0.4);';
      sep.textContent = '\u00B7';
      toast.appendChild(sep);

      const actionLabel = document.createElement('span');
      actionLabel.id = 'mast-badge-enable-label';
      actionLabel.style.cssText = 'font-weight: 700; color: #FF9F0A;';
      actionLabel.textContent = 'Enable Captions';
      toast.appendChild(actionLabel);

      toast.onclick = () => {
        if (didJustDragPill) {
          didJustDragPill = false;
          return;
        }
        actionLabel.textContent = 'Enabling...';
        triggerEnableCaptionsAllFrames();
        setTimeout(() => {
          if (currentToastState === 'captions_off_badge' && document.body.contains(actionLabel)) {
            actionLabel.textContent = 'Enable Captions';
          }
        }, 1200);
      };
    } else if (state === 'restored') {
      toast.setAttribute('data-tone', 'green');
      toast.setAttribute('data-mode', 'restored');
      toast.appendChild(createPillBrandEl('waveform', 'mast'));
      toast.appendChild(createPillSepEl());

      const textEl = document.createElement('span');
      textEl.className = 'mast-pill-text';
      textEl.textContent = 'Captions active \u2014 mast recording';
      toast.appendChild(textEl);

      captionsAlertTimer = setTimeout(() => {
        if (currentToastState === 'restored') {
          if (isTranscribing) {
            renderStatusToast('capturing_badge');
          } else {
            removeStatusToast();
          }
        }
      }, 2200);
    } else if (state === 'api_key_needed') {
      toast.setAttribute('data-tone', 'amber');
      toast.appendChild(createPillBrandEl('warning_amber', 'mast'));
      toast.appendChild(createPillSepEl());

      const textEl = document.createElement('span');
      textEl.className = 'mast-pill-text';
      textEl.textContent = 'Please save your Google AI Studio API key in Settings first';
      toast.appendChild(textEl);

      const actionsRow = document.createElement('div');
      actionsRow.className = 'mast-pill-actions';

      const settingsBtn = document.createElement('button');
      settingsBtn.id = 'mast-toast-settings-btn';
      settingsBtn.className = 'mast-pill-btn-amber';
      settingsBtn.textContent = 'Open Settings';
      settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        try {
          chrome.runtime.sendMessage({ action: 'open_options' }, () => {
            void chrome.runtime.lastError;
          });
        } catch (_) {}
      });

      const dismissBtn = document.createElement('button');
      dismissBtn.id = 'mast-toast-dismiss-btn';
      dismissBtn.className = 'mast-pill-btn-icon';
      dismissBtn.title = 'Dismiss';
      dismissBtn.setAttribute('aria-label', 'Dismiss');
      dismissBtn.textContent = '\u00D7';
      dismissBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeStatusToast();
      });

      actionsRow.appendChild(settingsBtn);
      actionsRow.appendChild(dismissBtn);
      toast.appendChild(actionsRow);

      statusToastTimer = setTimeout(() => {
        if (currentToastState === 'api_key_needed') {
          removeStatusToast();
        }
      }, 8000);
    } else if (state === 'generating') {
      toast.setAttribute('data-tone', 'indigo');
      toast.appendChild(createPillBrandEl('spinner', 'mast'));
      toast.appendChild(createPillSepEl());

      const progressWrap = document.createElement('div');
      progressWrap.className = 'mast-pill-progress-wrap';

      const stageRow = document.createElement('div');
      stageRow.id = 'mast-toast-progress-label';
      stageRow.style.cssText =
        'display: inline-flex; align-items: center; font-size: 12.5px; color: rgba(255, 255, 255, 0.92); overflow: hidden;';
      stageRow.innerHTML =
        '<span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Preparing meeting notes...</span>' +
        '<strong style="color: #a5a9ff; flex-shrink: 0; margin-left: 6px;">5%</strong>';

      const barTrack = document.createElement('div');
      barTrack.className = 'mast-pill-progress-track';

      const barFill = document.createElement('div');
      barFill.id = 'mast-toast-progress-fill';
      barFill.style.cssText =
        'height: 100%; width: 5%; background: linear-gradient(90deg, #5B5FC7 0%, #8B8FF8 100%); border-radius: 999px; transition: width 0.3s ease;';
      barTrack.appendChild(barFill);

      progressWrap.appendChild(stageRow);
      progressWrap.appendChild(barTrack);
      toast.appendChild(progressWrap);

      try {
        chrome.storage.local.get(['notesProgress', 'notesStage'], (s) => {
          if (chrome.runtime.lastError || !s) return;
          updateToastProgressUI(s.notesProgress, s.notesStage);
        });
      } catch (_) {}
    } else if (state === 'done') {
      toast.setAttribute('data-tone', 'green');
      toast.appendChild(createPillBrandEl('check_green', 'mast'));
      toast.appendChild(createPillSepEl());

      const textEl = document.createElement('span');
      textEl.className = 'mast-pill-text';
      textEl.textContent = 'AI notes and transcript downloaded';
      toast.appendChild(textEl);

      const dismissBtn = document.createElement('button');
      dismissBtn.id = 'mast-toast-dismiss-btn';
      dismissBtn.className = 'mast-pill-btn-icon';
      dismissBtn.title = 'Dismiss';
      dismissBtn.setAttribute('aria-label', 'Dismiss');
      dismissBtn.textContent = '\u00D7';
      dismissBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeStatusToast();
      });
      toast.appendChild(dismissBtn);

      statusToastTimer = setTimeout(() => {
        if (currentToastState === 'done') {
          removeStatusToast();
        }
      }, 6500);
    } else if (state === 'error') {
      toast.setAttribute('data-tone', 'red');
      toast.appendChild(createPillBrandEl('error_red', 'mast'));
      toast.appendChild(createPillSepEl());

      const textEl = document.createElement('span');
      textEl.className = 'mast-pill-text';
      textEl.textContent = errorMessage
        ? `AI notes failed (${errorMessage})`
        : 'Transcript downloaded, but AI notes failed';
      toast.appendChild(textEl);

      const actionsRow = document.createElement('div');
      actionsRow.className = 'mast-pill-actions';

      const retryBtn = document.createElement('button');
      retryBtn.id = 'mast-toast-retry-btn';
      retryBtn.className = 'mast-pill-btn-primary';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({ action: 'generate_notes' });
      });

      const dismissBtn = document.createElement('button');
      dismissBtn.id = 'mast-toast-dismiss-btn';
      dismissBtn.className = 'mast-pill-btn-icon';
      dismissBtn.title = 'Dismiss';
      dismissBtn.setAttribute('aria-label', 'Dismiss');
      dismissBtn.textContent = '\u00D7';
      dismissBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        shouldGuardUnload = false;
        removeStatusToast();
      });

      actionsRow.appendChild(retryBtn);
      actionsRow.appendChild(dismissBtn);
      toast.appendChild(actionsRow);
    }

    clampAndApplyPillPosition(toast);
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
    stopPillTimer();
    syncHideCaptionsStyle();
    removeCaptionsAlert();
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
    if (
      currentToastState === 'captions_off' ||
      currentToastState === 'captions_off_badge' ||
      currentToastState === 'capturing_started' ||
      currentToastState === 'capturing_badge' ||
      currentToastState === 'restored'
    ) {
      removeStatusToast();
    }
    sawActiveMeeting = false;
    missingCallChecks = 0;
    sawCaptionsActive = false;
    captionsOffDismissed = false;
    captionsAlertMinimized = false;
    capturingPillMinimized = false;
    transcriptionStartedAt = 0;
  }

  function startCallEndPolling() {
    if (callCheckInterval) clearInterval(callCheckInterval);
    sawActiveMeeting = isTeamsMeetingActive();
    missingCallChecks = 0;
    syncMeetingTitleToStorage();

    callCheckInterval = setInterval(() => {
      if (!isExtensionContextValid()) {
        if (typeof window.__mastContentScriptCleanup === 'function') {
          window.__mastContentScriptCleanup();
        }
        return;
      }
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
          captionsAlertMinimized = false;
          if (
            captionsAlertMode === 'alert' ||
            captionsAlertMode === 'badge' ||
            currentToastState === 'captions_off' ||
            currentToastState === 'captions_off_badge'
          ) {
            renderCaptionsAlert('restored');
          }
        } else if (sawCaptionsActive || (transcriptionStartedAt && Date.now() - transcriptionStartedAt >= 5000)) {
          const targetMode = captionsAlertMinimized ? 'badge' : 'alert';
          if (captionsAlertMode !== targetMode) {
            renderCaptionsAlert(targetMode);
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
    console.log("mast: startObserving() called. Looking for captions...");
    syncMeetingTitleToStorage();
    syncHideCaptionsStyle();
    fetchRemoteConfig();

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
            const rawSpeaker = speakerEl ? (speakerEl.innerText || speakerEl.textContent || '').trim() : '';
            if (rawSpeaker) {
              currentSpeaker = rawSpeaker;
              console.log("mast: Found speaker:", currentSpeaker);
            }

            const textEls = node.matches(TEXT_SELECTOR) ? [node] : node.querySelectorAll(TEXT_SELECTOR);
            for (let textEl of textEls) {
              if (!captionsMap.has(textEl)) {
                const rawText = (textEl.innerText || textEl.textContent || '').trim();
                captionsMap.set(textEl, { speaker: currentSpeaker, text: rawText });
                domChanged = true;
              }
            }
          }
        }
      });

      // 2. On EVERY mutation, sync the text for ALL tracked caption elements still on screen
      for (let [textEl, data] of captionsMap.entries()) {
        if (document.body.contains(textEl)) {
          const newText = (textEl.innerText || textEl.textContent || '').trim();
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
    const isMac = /Mac|iPod|iPhone|iPad/i.test(
      (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || ''
    );
    const primaryOpts = {
      key: 'c',
      code: 'KeyC',
      keyCode: 67,
      which: 67,
      altKey: !isMac,
      metaKey: isMac,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    };
    const fallbackOpts = {
      key: 'c',
      code: 'KeyC',
      keyCode: 67,
      which: 67,
      altKey: isMac,
      metaKey: !isMac,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    };
    console.log("mast: Attempting to enable captions via keyboard shortcut and menu trigger");
    document.dispatchEvent(new KeyboardEvent('keydown', primaryOpts));
    if (document.body) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', primaryOpts));
    }
    setTimeout(() => {
      if (!areCaptionsVisibleLocal()) {
        document.dispatchEvent(new KeyboardEvent('keydown', fallbackOpts));
        if (document.body) {
          document.body.dispatchEvent(new KeyboardEvent('keydown', fallbackOpts));
        }
      }
    }, 220);
    try {
      const explicitTurnOnBtn = document.querySelector(
        'button[aria-label*="Turn on live captions" i], [role="menuitem"][aria-label*="Turn on live captions" i], [data-tid="turn-on-captions"]'
      );
      if (explicitTurnOnBtn && typeof explicitTurnOnBtn.click === 'function') {
        explicitTurnOnBtn.click();
      }
    } catch (_) {}
  }

  function startMeetingDetectionLoop() {
    if (meetingDetectInterval) clearInterval(meetingDetectInterval);

    const checkMeetingPresence = () => {
      if (!isExtensionContextValid()) {
        if (typeof window.__mastContentScriptCleanup === 'function') {
          window.__mastContentScriptCleanup();
        }
        return;
      }
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
        if (meetingActive !== lastReportedInActiveCall) {
          lastReportedInActiveCall = meetingActive;
          try {
            chrome.storage.local.set({ inActiveCall: meetingActive });
          } catch (_) {}
        }
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
            renderStatusToast(capturingPillMinimized ? 'capturing_badge' : 'capturing_started');
          }
          return;
        }

        chrome.storage.local.get(['isTranscribing', 'notesStatus'], (res) => {
          if (chrome.runtime.lastError) return;
          if (res.isTranscribing) {
            if (currentToastState === 'meeting_detected') {
              renderStatusToast(capturingPillMinimized ? 'capturing_badge' : 'capturing_started');
            }
            return;
          }
          if (res.notesStatus === 'generating') return;
          if (meetingDetectedToastDismissed) return;
          if (
            currentToastState !== 'meeting_detected' &&
            currentToastState !== 'capturing_started' &&
            currentToastState !== 'capturing_badge' &&
            currentToastState !== 'captions_off' &&
            currentToastState !== 'captions_off_badge' &&
            currentToastState !== 'restored' &&
            currentToastState !== 'api_key_needed' &&
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

    if (changes.apiKey) {
      const hasNewKey = !!(changes.apiKey.newValue && String(changes.apiKey.newValue).trim());
      if (hasNewKey && currentToastState === 'api_key_needed' && isTeamsMeetingActive() && !isTranscribing) {
        renderStatusToast('meeting_detected');
      }
    }

    if (changes.hideCaptionBox) {
      hideCaptionBox = !!changes.hideCaptionBox.newValue;
      syncHideCaptionsStyle();
      const hideBtn = document.getElementById('mast-toast-hide-captions-btn');
      if (hideBtn) {
        hideBtn.textContent = hideCaptionBox ? 'Show Captions' : 'Hide Captions';
      }
    }

    if (changes.isTranscribing) {
      if (changes.isTranscribing.newValue === true && currentToastState === 'meeting_detected') {
        renderStatusToast('capturing_started');
      } else if (changes.isTranscribing.newValue === false) {
        isTranscribing = false;
        stopPillTimer();
        meetingDetectedToastDismissed = true;
        removeCaptionsAlert();
        removeHideCaptionsStyle();
        if (currentToastState === 'capturing_started' || currentToastState === 'capturing_badge') {
          removeStatusToast();
        }
      }
      syncHideCaptionsStyle();
    }

    if (changes.liveCaptionsOn && isTranscribing && window === window.top) {
      if (changes.liveCaptionsOn.newValue === true) {
        sawCaptionsActive = true;
        captionsOffDismissed = false;
        captionsAlertMinimized = false;
        if (
          captionsAlertMode === 'alert' ||
          captionsAlertMode === 'badge' ||
          currentToastState === 'captions_off' ||
          currentToastState === 'captions_off_badge'
        ) {
          renderCaptionsAlert('restored');
        }
      } else if (
        changes.liveCaptionsOn.newValue === false &&
        (sawCaptionsActive || (transcriptionStartedAt && Date.now() - transcriptionStartedAt >= 4000))
      ) {
        const targetMode = captionsAlertMinimized ? 'badge' : 'alert';
        if (captionsAlertMode !== targetMode) {
          renderCaptionsAlert(targetMode);
        }
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
        removeCaptionsAlert();
        renderStatusToast('generating');
      } else if (status === 'done') {
        shouldGuardUnload = false;
        removeCaptionsAlert();
        renderStatusToast('done');
      } else if (status === 'error') {
        shouldGuardUnload = true;
        removeCaptionsAlert();
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
      isTranscribing = true;
      transcriptionStartedAt = Date.now();
      sawCaptionsActive = areCaptionsVisible();
      captionsOffDismissed = false;
      captionsAlertMinimized = false;
      capturingPillMinimized = false;
      removeCaptionsAlert();
      syncHideCaptionsStyle();
      triggerEnableCaptionsAllFrames();
      startObserving();
      if (window === window.top) {
        renderStatusToast('capturing_started');
      }
      sendResponse({ status: "started" });
    } else if (request.action === "stop") {
      meetingDetectedToastDismissed = true;
      stopLocalObservation();
      sendResponse({ status: "stopped" });
    } else if (request.action === "force_captions") {
      triggerEnableCaptionsAllFrames();
      sendResponse({ status: "force_captions_sent" });
    }
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  window.__mastContentScriptCleanup = function () {
    if (meetingDetectInterval) clearInterval(meetingDetectInterval);
    if (callCheckInterval) clearInterval(callCheckInterval);
    stopPillTimer();
    if (issueTimer) clearTimeout(issueTimer);
    if (statusToastTimer) clearTimeout(statusToastTimer);
    if (captionsAlertTimer) clearTimeout(captionsAlertTimer);
    if (observer) observer.disconnect();
    removeStatusToast();
    removeCaptionsAlert();
    removeHideCaptionsStyle();
    const alertStyle = document.getElementById('mast-captions-alert-style');
    if (alertStyle) alertStyle.remove();
    const pillStyle = document.getElementById('mast-pill-style');
    if (pillStyle) pillStyle.remove();
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('message', onWindowMessage);
    window.removeEventListener('resize', onWindowResize);
    document.removeEventListener('__mast_cleanup_previous_instance', onCrossWorldCleanup);
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch (_) {}
  };

  try {
    chrome.storage.local.get(['hideCaptionBox', 'isTranscribing', 'startTime'], (stored) => {
      if (chrome.runtime.lastError || !stored) return;
      hideCaptionBox = !!stored.hideCaptionBox;
      if (stored.isTranscribing && isTeamsMeetingActive()) {
        isTranscribing = true;
        transcriptionStartedAt = stored.startTime || Date.now();
        sawCaptionsActive = areCaptionsVisible();
        syncHideCaptionsStyle();
        startObserving();
        if (window === window.top) {
          renderStatusToast(capturingPillMinimized ? 'capturing_badge' : 'capturing_started');
        }
      }
    });
  } catch (_) {}

  startMeetingDetectionLoop();
})();
