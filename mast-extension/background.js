// Background Service Worker for mast (Teams AI Minutes)

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "meeting_started" || request.action === "open_popup") {
    if (chrome.action && typeof chrome.action.openPopup === 'function') {
      const windowId = sender?.tab?.windowId;
      chrome.action.openPopup(windowId ? { windowId } : {})
        .then(() => {
          sendResponse({ status: "popup_opened" });
        })
        .catch((err) => {
          // In some Chrome versions, openPopup without user gesture is blocked by browser policy
          console.log("mast: Could not auto-open extension action popup:", err.message);
          sendResponse({ status: "popup_not_opened", error: err.message });
        });
      return true; // Keep message channel open for async response
    } else {
      sendResponse({ status: "openPopup_not_available" });
    }
  }
});
