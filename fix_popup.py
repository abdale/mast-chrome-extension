import re

with open('extension/popup.js', 'r') as f:
    content = f.read()

old_check = """async function checkCaptions() {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return false;
  try {
    let results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        const captionsOn = !!document.querySelector('[data-tid="closed-captions-container"], [data-tid="closed-caption-text"], [data-tid="author"], [aria-label*="caption" i], .ui-captions-container');
        let meetingTitle = "Meeting";
        if (document.title) {
            let extracted = document.title.split('|')[0].trim();
            if (extracted && !extracted.toLowerCase().includes('microsoft teams')) {
                meetingTitle = extracted;
            }
        }
        return { captionsOn, meetingTitle };
      }
    });
    if (!results) return false;
    const data = results.find(r => r.result &amp;&amp; r.result.captionsOn)?.result;
    if (data &amp;&amp; data.meetingTitle) {
      chrome.storage.local.set({ meetingTitle: data.meetingTitle });
    }
    return !!data;
  } catch (e) {
    return false;
  }
}"""

new_check = """async function checkPageStatus() {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { captionsOn: false, meetingTitle: "Meeting" };
  try {
    let results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        const captionsOn = !!document.querySelector('[data-tid="closed-captions-container"], [data-tid="closed-caption-text"], [data-tid="author"], [aria-label*="caption" i], .ui-captions-container');
        let meetingTitle = "Meeting";
        if (document.title) {
            let extracted = document.title.split('|')[0].trim();
            if (extracted && !extracted.toLowerCase().includes('microsoft teams')) {
                meetingTitle = extracted;
            }
        }
        return { captionsOn, meetingTitle };
      }
    });
    if (!results) return { captionsOn: false, meetingTitle: "Meeting" };
    
    let captionsOn = false;
    let meetingTitle = "Meeting";
    
    for (let r of results) {
      if (r.result) {
        if (r.result.captionsOn) captionsOn = true;
        if (r.result.meetingTitle && r.result.meetingTitle !== "Meeting") meetingTitle = r.result.meetingTitle;
      }
    }
    return { captionsOn, meetingTitle };
  } catch (e) {
    return { captionsOn: false, meetingTitle: "Meeting" };
  }
}"""

content = content.replace(old_check, new_check)
content = content.replace("const captionsOn = await checkCaptions();", "const captionsOn = pageStatus.captionsOn;")

with open('extension/popup.js', 'w') as f:
    f.write(content)
