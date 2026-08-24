import re

with open('extension/popup.js', 'r') as f:
    content = f.read()

old_func = """downloadBtn.addEventListener('click', () => {
  chrome.storage.local.get(['savedTranscript', 'meetingTitle'], (result) => {
    const lines = result.savedTranscript || [];
    if (lines.length === 0) return;
    const fullTranscript = lines.join('\\n');
    const blob = new Blob([fullTranscript], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const dateStr = new Date().toISOString().split('T')[0];
    const title = result.meetingTitle || "meeting";
    chrome.downloads.download({ url: url, filename: `transcript_${title}_${dateStr}.txt`, saveAs: false });
  });
});"""

new_func = """downloadBtn.addEventListener('click', () => {
  chrome.storage.local.get(['savedTranscript'], (result) => {
    const lines = result.savedTranscript || [];
    if (lines.length === 0) return;
    const fullTranscript = lines.join('\\n');
    const blob = new Blob([fullTranscript], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const d = new Date();
    const dateStr = d.toISOString().split('T')[0];
    const timeStr = d.toTimeString().split(' ')[0].replace(/:/g, '-');
    chrome.downloads.download({ url: url, filename: `transcript_${dateStr}_${timeStr}.txt`, saveAs: false });
  });
});"""

content = content.replace(old_func, new_func)

with open('extension/popup.js', 'w') as f:
    f.write(content)
