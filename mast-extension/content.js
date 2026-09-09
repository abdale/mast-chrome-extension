// Content Script for mast (Meeting AI Summarizer & Transcriber for MS Teams)

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

  // Meeting reminder state
  let reminderCard = null;
  let meetingPromptShown = false;
  let meetingCheckInterval = null;

  async function fetchRemoteConfig() {
    try {
      const res = await fetch("https://raw.githubusercontent.com/abdale/teams-ai-minutes/main/config.json");
      const json = await res.json();
      if (json.CAPTION_CONTAINER_SELECTOR) CAPTION_CONTAINER_SELECTOR = json.CAPTION_CONTAINER_SELECTOR;
      if (json.SPEAKER_SELECTOR) SPEAKER_SELECTOR = json.SPEAKER_SELECTOR;
      if (json.TEXT_SELECTOR) TEXT_SELECTOR = json.TEXT_SELECTOR;
      console.log("Teams AI Minutes: Remote config loaded.");
    } catch (e) {
      console.log("Teams AI Minutes: Using default DOM selectors.");
    }
  }

  async function startObserving() {
    if (observer) return;
    await fetchRemoteConfig();
    console.log("Teams AI Minutes: startObserving() called. Looking for captions...");

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
              console.log("Teams AI Minutes: Found speaker:", currentSpeaker);
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
  }

  // --- CROSS-PLATFORM CAPTION ACTIVATION (MAC & CHROMEBOOK / WINDOWS) ---
  function dispatchKeyEvents(target, combo) {
    if (!target || typeof target.dispatchEvent !== 'function') return;
    const eventInit = {
      key: combo.key,
      code: combo.code,
      keyCode: combo.keyCode,
      which: combo.keyCode,
      ctrlKey: !!combo.ctrlKey,
      altKey: !!combo.altKey,
      shiftKey: !!combo.shiftKey,
      metaKey: !!combo.metaKey,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window
    };
    try {
      target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
      target.dispatchEvent(new KeyboardEvent('keyup', eventInit));
    } catch (e) {
      // Ignore errors on restricted elements
    }
  }

  function attemptEnableCaptions() {
    console.log("Teams AI Minutes: Attempting to enable live captions...");

    // 1. Check if captions are already active
    const activeCaptions = document.querySelector(
      '[data-tid="closed-captions-container"], [data-tid="closed-caption-renderer-wrapper"], [data-tid="closed-caption-text"], .ui-captions-container'
    );
    if (activeCaptions) {
      console.log("Teams AI Minutes: Captions are already active.");
      return true;
    }

    // 2. Try direct DOM button if present
    const directBtn = document.querySelector(
      'button[data-tid="closed-captions-button"], button[data-tid*="caption" i], button[aria-label*="Turn on live captions" i]'
    );
    if (directBtn) {
      console.log("Teams AI Minutes: Found direct captions button. Clicking...");
      directBtn.click();
    }

    // 3. Try "More" (...) actions menu in Teams
    const moreBtn = document.querySelector(
      'button[data-tid="more-actions-button"], button[data-tid="overflow-button"], button[data-tid="callingButtons-showMoreBtn"], button[aria-label*="More" i], #more-actions-button'
    );
    if (moreBtn && !directBtn) {
      moreBtn.click();
      setTimeout(() => {
        const captionMenuItem = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="menuitemcheckbox"]')).find(el => {
          const text = (el.getAttribute('aria-label') || el.innerText || '').toLowerCase();
          return text.includes('caption') || text.includes('sous-titres') || text.includes('subtítulo');
        });
        if (captionMenuItem) {
          console.log("Teams AI Minutes: Found captions item in More menu. Clicking...");
          captionMenuItem.click();
        } else {
          // Close menu if not found
          moreBtn.click();
        }
      }, 250);
    }

    // 4. Platform-specific keyboard shortcut dispatch
    const platform = (navigator.platform || '').toUpperCase();
    const userAgent = navigator.userAgent || '';
    const isMac = platform.includes('MAC') || userAgent.includes('Macintosh') || userAgent.includes('Mac OS');

    const targets = [document.activeElement, document.body, document, window].filter(Boolean);

    if (isMac) {
      console.log("Teams AI Minutes: Dispatching Mac live captions shortcuts (Cmd+Shift+O / Cmd+Shift+K / Cmd+Shift+C)...");
      const macCombos = [
        { key: 'o', code: 'KeyO', keyCode: 79, metaKey: true, shiftKey: true },
        { key: 'k', code: 'KeyK', keyCode: 75, metaKey: true, shiftKey: true },
        { key: 'c', code: 'KeyC', keyCode: 67, metaKey: true, shiftKey: true },
        { key: 'c', code: 'KeyC', keyCode: 67, altKey: true, shiftKey: true }
      ];
      for (const combo of macCombos) {
        for (const target of targets) {
          dispatchKeyEvents(target, combo);
        }
      }
    } else {
      console.log("Teams AI Minutes: Dispatching Chromebook/Windows live captions shortcuts (Alt+Shift+C / Ctrl+Shift+K)...");
      const nonMacCombos = [
        { key: 'c', code: 'KeyC', keyCode: 67, altKey: true, shiftKey: true },
        { key: 'k', code: 'KeyK', keyCode: 75, ctrlKey: true, shiftKey: true },
        { key: 'c', code: 'KeyC', keyCode: 67, ctrlKey: true, shiftKey: true },
        { key: 'o', code: 'KeyO', keyCode: 79, ctrlKey: true, shiftKey: true }
      ];
      for (const combo of nonMacCombos) {
        for (const target of targets) {
          dispatchKeyEvents(target, combo);
        }
      }
    }
  }

  // --- TEAMS MEETING DETECTION & IN-PAGE REMINDER ---
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
      '[data-tid="closed-caption-renderer-wrapper"]'
    ];
    return meetingSelectors.some(sel => !!document.querySelector(sel));
  }

  function createInMeetingReminder() {
    if (document.getElementById('mast-meeting-reminder')) return;

    const card = document.createElement('div');
    card.id = 'mast-meeting-reminder';
    card.style.cssText = `
      position: fixed;
      top: 24px;
      right: 24px;
      z-index: 2147483647;
      background: #ffffff;
      border: 1px solid #d1d5db;
      border-radius: 12px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
      padding: 16px 18px;
      width: 320px;
      max-width: calc(100vw - 48px);
      font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
      color: #1f2937;
      transition: all 0.25s ease-in-out;
    `;

    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <div style="display: flex; align-items: center; gap: 6px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5B5FC7" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle;">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
            <line x1="12" y1="19" x2="12" y2="23"></line>
            <line x1="8" y1="23" x2="16" y2="23"></line>
          </svg>
          <span style="font-weight: 700; font-size: 13px; color: #5B5FC7; letter-spacing: -0.2px;">mast</span>
          <span style="font-size: 11px; color: #6b7280;">· Meeting Assistant</span>
        </div>
        <button id="mast-dismiss-x" style="background: none; border: none; font-size: 16px; color: #9ca3af; cursor: pointer; padding: 0 4px; line-height: 1;">&times;</button>
      </div>
      
      <div style="font-size: 13px; font-weight: 600; color: #111827; margin-bottom: 4px;">
        Meeting in Progress
      </div>
      <div style="font-size: 12px; color: #4b5563; line-height: 1.4; margin-bottom: 14px;">
        Would you like to transcribe and generate AI meeting notes for this call?
      </div>

      <div style="display: flex; align-items: center; justify-content: flex-end; gap: 8px;">
        <button id="mast-btn-dismiss" style="background: transparent; border: none; color: #6b7280; font-size: 12px; padding: 6px 10px; cursor: pointer; border-radius: 4px;">
          Not Now
        </button>
        <button id="mast-btn-start" style="background: #5B5FC7; border: none; color: #ffffff; font-weight: 600; font-size: 12px; padding: 7px 14px; border-radius: 6px; cursor: pointer; box-shadow: 0 1px 3px rgba(91, 95, 199, 0.4); display: flex; align-items: center; gap: 5px;">
          Start AI Notes
        </button>
      </div>
    `;

    document.body.appendChild(card);
    reminderCard = card;

    const dismissBtn = card.querySelector('#mast-btn-dismiss');
    const dismissX = card.querySelector('#mast-dismiss-x');
    const startBtn = card.querySelector('#mast-btn-start');

    const closeCard = () => {
      card.style.opacity = '0';
      card.style.transform = 'translateY(-10px)';
      setTimeout(() => {
        card.remove();
        reminderCard = null;
      }, 250);
    };

    dismissBtn?.addEventListener('click', closeCard);
    dismissX?.addEventListener('click', closeCard);

    startBtn?.addEventListener('click', () => {
      startBtn.innerText = "Starting...";
      startBtn.disabled = true;

      // 1. Enable live captions (works on both Mac and Chromebook/Windows)
      attemptEnableCaptions();

      // 2. Start transcription in storage
      const startTime = Date.now();
      chrome.storage.local.set({
        savedTranscript: [],
        isTranscribing: true,
        startTime: startTime,
        issueDetected: false,
        activeTabId: null
      }, () => {
        isTranscribing = true;
        startObserving();
      });

      // 3. Transform card into sleek compact pill indicating recording
      card.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background-color: #ef4444; box-shadow: 0 0 6px #ef4444;"></span>
            <span style="font-size: 12px; font-weight: 600; color: #111827;">Transcribing AI Notes...</span>
          </div>
          <button id="mast-pill-stop" style="background: #fee2e2; border: 1px solid #fca5a5; color: #b91c1c; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 4px; cursor: pointer;">
            Stop
          </button>
        </div>
      `;
      card.style.width = 'auto';
      card.style.padding = '10px 14px';

      const stopBtn = card.querySelector('#mast-pill-stop');
      stopBtn?.addEventListener('click', () => {
        chrome.storage.local.set({ isTranscribing: false, activeTabId: null });
        isTranscribing = false;
        captionsMap.clear();
        if (issueTimer) clearTimeout(issueTimer);
        if (observer) {
          observer.disconnect();
          observer = null;
        }

        card.innerHTML = `
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="color: #10b981; font-weight: bold;">✓</span>
            <span style="font-size: 12px; color: #111827;">Notes saved! Open the <b>mast</b> extension to generate summary.</span>
            <button id="mast-pill-close" style="background: none; border: none; font-size: 14px; color: #9ca3af; cursor: pointer; margin-left: 6px;">&times;</button>
          </div>
        `;
        card.querySelector('#mast-pill-close')?.addEventListener('click', closeCard);
        setTimeout(closeCard, 6000);
      });
    });
  }

  function checkAndShowMeetingReminder() {
    const active = isTeamsMeetingActive();

    // If meeting is not active, clean up any existing reminder card and reset
    if (!active) {
      if (reminderCard) {
        reminderCard.remove();
        reminderCard = null;
      }
      meetingPromptShown = false;
      return;
    }

    // If meeting is active, but we already prompted or already transcribing, skip
    if (isTranscribing || meetingPromptShown || document.getElementById('mast-meeting-reminder')) {
      return;
    }

    meetingPromptShown = true;

    // Attempt to notify background service worker to open the extension toolbar popup
    try {
      chrome.runtime.sendMessage({ action: "meeting_started" }, () => {
        if (chrome.runtime.lastError) {
          // Service worker may be asleep or blocked
        }
      });
    } catch (e) {
      // Ignore background message failure
    }

    // Also display the in-meeting prompt card
    createInMeetingReminder();
  }

  // Poll for meeting start every 2 seconds
  meetingCheckInterval = setInterval(checkAndShowMeetingReminder, 2000);

  // Sync state when popup toggles transcription
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.isTranscribing) {
      isTranscribing = changes.isTranscribing.newValue;
      if (isTranscribing) {
        const card = document.getElementById('mast-meeting-reminder');
        if (card && !card.querySelector('#mast-pill-stop')) {
          card.remove();
          reminderCard = null;
        }
      }
    }
  });

  // Message listener from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "start") {
      isTranscribing = true;
      startObserving();
      sendResponse({ status: "started" });
    } else if (request.action === "stop") {
      isTranscribing = false;
      captionsMap.clear();
      if (issueTimer) clearTimeout(issueTimer);
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      sendResponse({ status: "stopped" });
    } else if (request.action === "force_captions") {
      attemptEnableCaptions();
      sendResponse({ status: "force_captions_sent" });
    }
  });

})();
