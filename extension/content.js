let isTranscribing = false;
let observer = null;

const CAPTION_CONTAINER_SELECTOR = '[data-tid="closed-captions-container"]'; 
const SPEAKER_SELECTOR = '.speaker-name-class'; 
const TEXT_SELECTOR = '.caption-text-class'; 

function startObserving() {
  if (observer) return;
  
  const targetNode = document.querySelector('body'); 
  observer = new MutationObserver((mutations) => {
    if (!isTranscribing) return;

    let newTranscriptChunks = [];
    mutations.forEach((mutation) => {
      for (let node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const speakerEl = node.querySelector(SPEAKER_SELECTOR);
          const textEl = node.querySelector(TEXT_SELECTOR);
          
          if (speakerEl && textEl) {
            const speaker = speakerEl.innerText.trim();
            const text = textEl.innerText.trim();
            if (speaker && text) {
              newTranscriptChunks.push(`[${speaker}]: ${text}`);
            }
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
