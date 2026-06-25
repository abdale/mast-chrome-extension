let isTranscribing = false;
let observer = null;

const CAPTION_CONTAINER_SELECTOR = '[data-tid="closed-captions-container"]'; 
const SPEAKER_SELECTOR = '[data-tid="author"]'; 
const TEXT_SELECTOR = '[data-tid="closed-caption-text"]'; 

let currentSpeaker = "Unknown";
let captionsMap = new Map(); // DOM Element -> { speaker, text }

function startObserving() {
  if (observer) return;
  console.log("Teams AI Minutes: startObserving() called. Looking for captions...");
  
  const targetNode = document.querySelector('body'); 
  observer = new MutationObserver((mutations) => {
    if (!isTranscribing) return;

    let domChanged = false;

    // 1. Check for newly added caption or speaker elements
    mutations.forEach((mutation) => {
      for (let node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          
          // Check for speaker
          const speakerEl = node.matches(SPEAKER_SELECTOR) ? node : node.querySelector(SPEAKER_SELECTOR);
          if (speakerEl && speakerEl.innerText.trim()) {
            currentSpeaker = speakerEl.innerText.trim();
            console.log("Teams AI Minutes: Found speaker:", currentSpeaker);
          }

          // Check for text elements
          const textEls = node.matches(TEXT_SELECTOR) ? [node] : node.querySelectorAll(TEXT_SELECTOR);
          for (let textEl of textEls) {
            if (!captionsMap.has(textEl)) {
              captionsMap.set(textEl, { speaker: currentSpeaker, text: textEl.innerText.trim() });
              domChanged = true;
            }
          }
        }
      }
    });

    // 2. On EVERY mutation, sync the text for ALL tracked caption elements still on screen
    for (let [textEl, data] of captionsMap.entries()) {
      if (document.body.contains(textEl)) {
        const newText = textEl.innerText.trim();
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
}

let waitingInterval = null;

function showCaptionOverlay() {
  if (document.getElementById('mast-caption-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'mast-caption-overlay';
  overlay.style.cssText = 'position: fixed; top: 20px; right: 20px; background: #5B5FC7; color: white; padding: 15px; border-radius: 8px; z-index: 999999; box-shadow: 0 4px 12px rgba(0,0,0,0.2); font-family: sans-serif; font-size: 14px; transition: opacity 0.3s;';
  overlay.innerHTML = '<strong>mast is waiting!</strong><br>Press <kbd style="background: #fff; color: #000; padding: 2px 5px; border-radius: 3px; font-size: 12px;">Alt+Shift+C</kbd> to turn on live captions.';
  document.body.appendChild(overlay);
}

function removeCaptionOverlay() {
  const overlay = document.getElementById('mast-caption-overlay');
  if (overlay) overlay.remove();
}

function checkAndStart() {
  if (!isTranscribing) return;
  const hasCaptions = document.querySelector('[data-tid="closed-captions-container"], [data-tid="closed-caption-text"], [data-tid="author"]');
  if (hasCaptions) {
    if (waitingInterval) {
      clearInterval(waitingInterval);
      waitingInterval = null;
    }
    removeCaptionOverlay();
    startObserving();
  } else {
    showCaptionOverlay();
    if (!waitingInterval) {
      waitingInterval = setInterval(checkAndStart, 1000);
    }
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "start") {
    isTranscribing = true;
    checkAndStart();
    sendResponse({ status: "started" });
  } else if (request.action === "stop") {
    isTranscribing = false;
    if (waitingInterval) {
      clearInterval(waitingInterval);
      waitingInterval = null;
    }
    removeCaptionOverlay();
    captionsMap.clear();
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    sendResponse({ status: "stopped" });
  }
});
