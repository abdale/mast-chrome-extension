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

  async function startObserving() {
    if (observer) return;
    await fetchRemoteConfig();
    console.log("mast: startObserving() called. Looking for captions...");

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
    console.log("mast: Attempting to enable live captions...");

    // 1. Check if captions are already active
    const activeCaptions = document.querySelector(
      '[data-tid="closed-captions-container"], [data-tid="closed-caption-renderer-wrapper"], [data-tid="closed-caption-text"], .ui-captions-container'
    );
    if (activeCaptions) {
      console.log("mast: Captions are already active.");
      return true;
    }

    // 2. Try direct DOM button if present on toolbar
    const directBtn = document.querySelector(
      'button[data-tid="closed-captions-button"], button[data-tid*="caption" i], button[aria-label*="Turn on live captions" i], button[aria-label*="Show live captions" i]'
    );
    if (directBtn) {
      console.log("mast: Found direct captions button. Clicking...");
      directBtn.click();
      return true;
    }

    // 3. Try "More" (...) actions menu in Teams
    const moreBtn = document.querySelector(
      'button[data-tid="more-actions-button"], button[data-tid="overflow-button"], button[data-tid="callingButtons-showMoreBtn"], button[aria-label*="More actions" i], button[aria-label="More" i], #more-actions-button'
    );
    if (moreBtn && !directBtn) {
      console.log("mast: Opening More actions menu...");
      moreBtn.click();
      setTimeout(() => {
        const menuItems = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="menuitemcheckbox"]'));

        // Check if captions are already active
        const turnOffItem = menuItems.find(el => {
          const text = (el.getAttribute('aria-label') || el.innerText || '').toLowerCase();
          return text.includes('turn off live captions') || text.includes('turn off captions');
        });
        if (turnOffItem) {
          moreBtn.click();
          return;
        }

        // Direct caption item in More menu
        const captionMenuItem = menuItems.find(el => {
          const text = (el.getAttribute('aria-label') || el.innerText || '').toLowerCase();
          return text.includes('turn on live captions') || text.includes('show live captions') || text.includes('turn on captions');
        });
        if (captionMenuItem) {
          console.log("mast: Found captions item in More menu. Clicking...");
          captionMenuItem.click();
          return;
        }

        // Modern Teams: Language and speech submenu
        const langSpeechItem = menuItems.find(el => {
          const text = (el.getAttribute('aria-label') || el.innerText || '').toLowerCase();
          return text.includes('language and speech') || text.includes('language & speech');
        });
        if (langSpeechItem) {
          console.log("mast: Opening Language & speech submenu...");
          langSpeechItem.click();
          setTimeout(() => {
            const subItems = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="menuitemcheckbox"]'));
            const subCaptionItem = subItems.find(el => {
              const text = (el.getAttribute('aria-label') || el.innerText || '').toLowerCase();
              return text.includes('live captions') || text.includes('turn on') || text.includes('captions');
            });
            if (subCaptionItem) {
              console.log("mast: Found live captions in submenu. Clicking...");
              subCaptionItem.click();
            } else {
              moreBtn.click();
            }
          }, 200);
        } else {
          // Fallback: search for any item containing caption
          const genericCaptionItem = menuItems.find(el => {
            const text = (el.getAttribute('aria-label') || el.innerText || '').toLowerCase();
            return text.includes('caption') || text.includes('sous-titres') || text.includes('subtítulo');
          });
          if (genericCaptionItem) {
            genericCaptionItem.click();
          } else {
            moreBtn.click();
          }
        }
      }, 200);
    }

    // 4. Safe platform-specific keyboard shortcuts
    // IMPORTANT: NEVER dispatch KeyO (which toggles Camera in Teams) or KeyK (which raises Hand in Teams)!
    const platform = (navigator.platform || '').toUpperCase();
    const userAgent = navigator.userAgent || '';
    const isMac = platform.includes('MAC') || userAgent.includes('Macintosh') || userAgent.includes('Mac OS');

    if (!isMac) {
      // Windows & Chromebook: Alt+Shift+C is the documented Teams live captions shortcut
      console.log("mast: Dispatching Windows/Chromebook live captions shortcut (Alt+Shift+C)...");
      const targets = [document.activeElement, document.body, document, window].filter(Boolean);
      for (const target of targets) {
        dispatchKeyEvents(target, { key: 'c', code: 'KeyC', keyCode: 67, altKey: true, shiftKey: true });
      }
    }
  }

  // --- DRAGGABLE SLEEK RECORDING PILL & REMINDER ---
  let pillMouseMoveHandler = null;
  let pillAutoHideTimeout = null;
  let pillDragCleanup = null;

  function getSavedPillPosition() {
    try {
      const saved = sessionStorage.getItem('mast_pill_pos');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.left === 'number' && typeof parsed.top === 'number') {
          const left = Math.max(12, Math.min(window.innerWidth - 200, parsed.left));
          const top = Math.max(12, Math.min(window.innerHeight - 60, parsed.top));
          return { left, top };
        }
      }
    } catch (e) {}
    return null;
  }

  function savePillPosition(pos) {
    try {
      sessionStorage.setItem('mast_pill_pos', JSON.stringify(pos));
    } catch (e) {}
  }

  function makeDraggable(element, onDragEnd) {
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    const onPointerDown = (e) => {
      // Don't initiate drag if clicking buttons, links, or close buttons
      if (e.target.closest('button, a, input, [role="button"]')) return;

      isDragging = true;
      element.style.cursor = 'grabbing';
      element.style.userSelect = 'none';
      element.style.transition = 'none'; // Disable transition during drag for smoothness
      try {
        element.setPointerCapture(e.pointerId);
      } catch (err) {}

      const rect = element.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      initialLeft = rect.left;
      initialTop = rect.top;

      element.style.bottom = 'auto';
      element.style.right = 'auto';
      element.style.left = `${initialLeft}px`;
      element.style.top = `${initialTop}px`;

      e.preventDefault();
    };

    const onPointerMove = (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const rect = element.getBoundingClientRect();
      const maxLeft = Math.max(12, window.innerWidth - rect.width - 12);
      const maxTop = Math.max(12, window.innerHeight - rect.height - 12);

      const newLeft = Math.max(12, Math.min(maxLeft, initialLeft + dx));
      const newTop = Math.max(12, Math.min(maxTop, initialTop + dy));

      element.style.left = `${newLeft}px`;
      element.style.top = `${newTop}px`;
    };

    const onPointerUp = (e) => {
      if (!isDragging) return;
      isDragging = false;
      element.style.cursor = 'grab';
      element.style.userSelect = '';
      element.style.transition = 'opacity 0.35s cubic-bezier(0.4, 0, 0.2, 1), transform 0.35s cubic-bezier(0.4, 0, 0.2, 1)';
      try {
        element.releasePointerCapture(e.pointerId);
      } catch (err) {}

      const rect = element.getBoundingClientRect();
      if (typeof onDragEnd === 'function') {
        onDragEnd({ left: rect.left, top: rect.top });
      }
    };

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerUp);

    return () => {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerUp);
    };
  }

  function removeRecordingPill() {
    if (pillAutoHideTimeout) {
      clearTimeout(pillAutoHideTimeout);
      pillAutoHideTimeout = null;
    }
    if (pillMouseMoveHandler) {
      window.removeEventListener('mousemove', pillMouseMoveHandler);
      pillMouseMoveHandler = null;
    }
    if (pillDragCleanup) {
      pillDragCleanup();
      pillDragCleanup = null;
    }
    const card = document.getElementById('mast-meeting-reminder');
    if (card) {
      card.remove();
      reminderCard = null;
    }
  }

  function showRecordingPill() {
    removeRecordingPill();

    let card = document.getElementById('mast-meeting-reminder');
    if (!card) {
      card = document.createElement('div');
      card.id = 'mast-meeting-reminder';
      document.body.appendChild(card);
    }
    reminderCard = card;

    // Inject pulse animation style once
    if (!document.getElementById('mast-pill-styles')) {
      const style = document.createElement('style');
      style.id = 'mast-pill-styles';
      style.textContent = `
        @keyframes mast-red-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.35; transform: scale(0.85); }
        }
      `;
      document.head.appendChild(style);
    }

    const savedPos = getSavedPillPosition();
    const defaultLeft = 24;
    const defaultTop = Math.max(12, window.innerHeight - 74);
    const startLeft = savedPos ? savedPos.left : defaultLeft;
    const startTop = savedPos ? savedPos.top : defaultTop;

    card.className = 'mast-recording-pill';
    card.style.cssText = `
      position: fixed;
      left: ${startLeft}px;
      top: ${startTop}px;
      z-index: 2147483647;
      background: rgba(255, 255, 255, 0.96);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid rgba(209, 213, 219, 0.9);
      border-radius: 20px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12), 0 2px 4px rgba(0, 0, 0, 0.06);
      padding: 7px 14px;
      font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
      color: #1f2937;
      display: flex;
      align-items: center;
      gap: 12px;
      width: auto;
      max-width: calc(100vw - 48px);
      opacity: 1;
      pointer-events: auto;
      cursor: grab;
      transform: scale(1);
      transition: opacity 0.35s cubic-bezier(0.4, 0, 0.2, 1), transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
    `;

    card.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; cursor: grab;" title="Drag to reposition">
        <svg width="8" height="12" viewBox="0 0 8 12" fill="#9ca3af" style="flex-shrink: 0; opacity: 0.8;">
          <circle cx="2" cy="2" r="1.2" />
          <circle cx="6" cy="2" r="1.2" />
          <circle cx="2" cy="6" r="1.2" />
          <circle cx="6" cy="6" r="1.2" />
          <circle cx="2" cy="10" r="1.2" />
          <circle cx="6" cy="10" r="1.2" />
        </svg>
        <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background-color: #ef4444; box-shadow: 0 0 6px #ef4444; animation: mast-red-pulse 1.8s infinite;"></span>
        <span style="font-size: 12px; font-weight: 600; color: #111827; white-space: nowrap; user-select: none;">Transcribing AI Notes...</span>
      </div>
      <button id="mast-pill-stop" style="background: #fee2e2; border: 1px solid #fca5a5; color: #b91c1c; font-size: 11px; font-weight: 600; padding: 4px 9px; border-radius: 5px; cursor: pointer;">
        Stop
      </button>
    `;

    let startedTime = Date.now();
    let isHovered = false;
    let isCurrentlyDragging = false;

    const fadeOut = () => {
      if (!isHovered && !isCurrentlyDragging && isTranscribing) {
        card.style.opacity = '0';
        card.style.pointerEvents = 'none'; // Click-through when invisible
        card.style.transform = 'scale(0.96)';
      }
    };

    const fadeIn = () => {
      card.style.opacity = '1';
      card.style.pointerEvents = 'auto';
      card.style.transform = 'scale(1)';
    };

    const resetFadeTimeout = () => {
      if (pillAutoHideTimeout) clearTimeout(pillAutoHideTimeout);
      startedTime = Date.now();
      pillAutoHideTimeout = setTimeout(fadeOut, 30000);
    };

    // Auto-hide after 30 seconds
    pillAutoHideTimeout = setTimeout(fadeOut, 30000);

    // Make pill smoothly draggable and persist position
    pillDragCleanup = makeDraggable(card, (newPos) => {
      isCurrentlyDragging = false;
      savePillPosition(newPos);
      fadeIn();
      resetFadeTimeout();
    });

    card.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('button')) {
        isCurrentlyDragging = true;
        fadeIn();
      }
    });

    // Proximity hover detection near current position
    let lastMoveTime = 0;
    pillMouseMoveHandler = (e) => {
      if (isCurrentlyDragging) return;
      const now = Date.now();
      if (now - lastMoveTime < 60) return;
      lastMoveTime = now;

      const rect = card.getBoundingClientRect();
      const isNear = (
        e.clientX >= rect.left - 45 &&
        e.clientX <= rect.right + 45 &&
        e.clientY >= rect.top - 45 &&
        e.clientY <= rect.bottom + 45
      );

      if (isNear) {
        if (!isHovered) {
          isHovered = true;
          fadeIn();
        }
      } else {
        if (isHovered) {
          isHovered = false;
          if (Date.now() - startedTime >= 30000) {
            fadeOut();
          }
        }
      }
    };
    window.addEventListener('mousemove', pillMouseMoveHandler, { passive: true });

    const stopBtn = card.querySelector('#mast-pill-stop');
    stopBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pillAutoHideTimeout) clearTimeout(pillAutoHideTimeout);
      if (pillMouseMoveHandler) {
        window.removeEventListener('mousemove', pillMouseMoveHandler);
        pillMouseMoveHandler = null;
      }
      if (pillDragCleanup) {
        pillDragCleanup();
        pillDragCleanup = null;
      }

      chrome.storage.local.set({ isTranscribing: false, activeTabId: null });
      isTranscribing = false;
      captionsMap.clear();
      if (issueTimer) clearTimeout(issueTimer);
      if (observer) {
        observer.disconnect();
        observer = null;
      }

      card.className = '';
      card.style.cursor = 'default';
      card.style.opacity = '1';
      card.style.pointerEvents = 'auto';
      card.style.transform = 'scale(1)';
      card.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="color: #10b981; font-weight: bold; font-size: 13px;">✓</span>
          <span style="font-size: 12px; color: #111827;">Notes saved! Open <b>mast</b> extension to summarize.</span>
          <button id="mast-pill-close" style="background: none; border: none; font-size: 15px; color: #9ca3af; cursor: pointer; padding: 0 4px; line-height: 1;">&times;</button>
        </div>
      `;

      const closePill = () => {
        card.style.opacity = '0';
        card.style.pointerEvents = 'none';
        card.style.transform = 'scale(0.96)';
        setTimeout(() => {
          removeRecordingPill();
        }, 250);
      };

      card.querySelector('#mast-pill-close')?.addEventListener('click', closePill);
      setTimeout(closePill, 5000);
    });
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

    const savedPos = getSavedPillPosition();
    const defaultLeft = 24;
    const defaultTop = Math.max(12, window.innerHeight - 175);
    const startLeft = savedPos ? savedPos.left : defaultLeft;
    const startTop = savedPos ? Math.min(window.innerHeight - 175, savedPos.top) : defaultTop;

    card.style.cssText = `
      position: fixed;
      left: ${startLeft}px;
      top: ${startTop}px;
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
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0);
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
      card.style.pointerEvents = 'none';
      card.style.transform = 'translateY(10px)';
      setTimeout(() => {
        removeRecordingPill();
      }, 250);
    };

    dismissBtn?.addEventListener('click', closeCard);
    dismissX?.addEventListener('click', closeCard);

    startBtn?.addEventListener('click', () => {
      startBtn.innerText = "Starting...";
      startBtn.disabled = true;

      // 1. Enable live captions (safe DOM automation, no camera/hand side effects)
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
        showRecordingPill();
      });
    });
  }

  function checkAndShowMeetingReminder() {
    const active = isTeamsMeetingActive();

    // If meeting is not active, clean up any existing reminder card and reset
    if (!active) {
      removeRecordingPill();
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
        showRecordingPill();
      } else {
        removeRecordingPill();
      }
    }
  });

  // Message listener from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "start") {
      isTranscribing = true;
      startObserving();
      showRecordingPill();
      sendResponse({ status: "started" });
    } else if (request.action === "stop") {
      isTranscribing = false;
      captionsMap.clear();
      if (issueTimer) clearTimeout(issueTimer);
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      removeRecordingPill();
      sendResponse({ status: "stopped" });
    } else if (request.action === "force_captions") {
      attemptEnableCaptions();
      sendResponse({ status: "force_captions_sent" });
    }
  });

})();
