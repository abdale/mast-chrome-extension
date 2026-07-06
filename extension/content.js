let isTranscribing = false;
let observer = null;

let CAPTION_CONTAINER_SELECTOR = '[data-tid="closed-captions-container"]'; 
let SPEAKER_SELECTOR = '[data-tid="author"]'; 
let TEXT_SELECTOR = '[data-tid="closed-caption-text"]'; 

let currentSpeaker = "Unknown";
let issueTimer = null;
let captionsMap = new Map(); // DOM Element -> { speaker, text }

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
  issueTimer = setTimeout(() => {
    if (captionsMap.size === 0) {
      chrome.storage.local.set({ issueDetected: true });
    }
  }, 5 * 60 * 1000); // 5 minutes
  
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
    console.log("Teams AI Minutes: Attempting to force captions via Alt+Shift+C");
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
    sendResponse({ status: "force_captions_sent" });
  }
});
