document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKey');
  const saveBtn = document.getElementById('saveBtn');
  const statusEl = document.getElementById('status');

  // Load saved API key
  chrome.storage.local.get(['apiKey'], (result) => {
    if (result.apiKey) {
      apiKeyInput.value = result.apiKey;
    }
  });

  saveBtn.addEventListener('click', () => {
    const apiKey = apiKeyInput.value.trim();
    chrome.storage.local.set({ apiKey: apiKey }, () => {
      statusEl.innerText = "Settings saved successfully!";
      setTimeout(() => {
        statusEl.innerText = "";
      }, 3000);
    });
  });
});
