let isTranscribing = false;
let observer = null;

const CAPTION_CONTAINER_SELECTOR = '[data-tid="closed-captions-container"]'; 
const SPEAKER_SELECTOR = '[data-tid="author"]'; 
const TEXT_SELECTOR = '[data-tid="closed-caption-text"]'; 

let currentSpeaker = "Unknown";

function startObserving() {
  if (observer) return;
  console.log("Teams AI Minutes: startObserving() called. Looking for captions...");
  
  const targetNode = document.querySelector('body'); 
  observer = new MutationObserver((mutations) => {
    if (!isTranscribing) return;
    console.log(`Teams AI Minutes: Observed ${mutations.length} mutations.`);

    let newTranscriptChunks = [];
    mutations.forEach((mutation) => {
      for (let node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          
          // 1. Check if an author node was added (or is inside the added node)
          const speakerEl = node.matches(SPEAKER_SELECTOR) ? node : node.querySelector(SPEAKER_SELECTOR);
          if (speakerEl && speakerEl.innerText.trim()) {
            currentSpeaker = speakerEl.innerText.trim();
            console.log("Teams AI Minutes: Found speaker:", currentSpeaker);
          }

          // 2. Check if a text node was added (or is inside the added node)
          const textEl = node.matches(TEXT_SELECTOR) ? node : node.querySelector(TEXT_SELECTOR);
          if (textEl && textEl.innerText.trim()) {
            const text = textEl.innerText.trim();
            console.log("Teams AI Minutes: Found text:", text);
            newTranscriptChunks.push(`[${currentSpeaker}]: ${text}`);
          }
        }
      }
    });

    if (newTranscriptChunks.length > 0) {
      chrome.storage.local.get(['savedTranscript'], (result) => {
        const existing = result.savedTranscript || [];
        chrome.storage.local.set({ savedTranscript: [...existing, ...newTranscriptChunks] });
      });
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
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    sendResponse({ status: "stopped" });
  }
});
