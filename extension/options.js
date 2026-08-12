document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKey');
  const modelSelect = document.getElementById('modelSelect');
  const customModelContainer = document.getElementById('customModelContainer');
  const customModelInput = document.getElementById('customModel');
  const saveBtn = document.getElementById('saveBtn');
  const statusEl = document.getElementById('status');

  // Load saved settings
  chrome.storage.local.get(['apiKey', 'modelSelectVal', 'customModelVal'], (result) => {
    if (result.apiKey) {
      apiKeyInput.value = result.apiKey;
    }
    
    if (result.modelSelectVal) {
      modelSelect.value = result.modelSelectVal;
    } else {
      modelSelect.value = 'gemini-2.5-flash';
    }
    
    if (result.customModelVal) {
      customModelInput.value = result.customModelVal;
    }

    // Trigger initial visibility of custom model container
    toggleCustomModelVisibility();
  });

  // Toggle custom model input visibility based on dropdown selection
  function toggleCustomModelVisibility() {
    if (modelSelect.value === 'custom') {
      customModelContainer.style.display = 'block';
    } else {
      customModelContainer.style.display = 'none';
    }
  }

  modelSelect.addEventListener('change', toggleCustomModelVisibility);

  saveBtn.addEventListener('click', () => {
    const apiKey = apiKeyInput.value.trim();
    const modelSelectVal = modelSelect.value;
    const customModelVal = customModelInput.value.trim();
    
    let selectedModel = modelSelectVal;
    
    if (modelSelectVal === 'custom') {
      if (!customModelVal) {
        statusEl.innerText = "Error: Please enter a Custom Model ID.";
        statusEl.style.color = "#d32f2f";
        return;
      }
      selectedModel = customModelVal;
    }

    statusEl.innerText = "Saving settings...";
    statusEl.style.color = "#5B5FC7";

    chrome.storage.local.set({
      apiKey: apiKey,
      selectedModel: selectedModel,
      modelSelectVal: modelSelectVal,
      customModelVal: customModelVal
    }, () => {
      statusEl.innerText = "Settings saved successfully!";
      statusEl.style.color = "#2e7d32";
      setTimeout(() => {
        statusEl.innerText = "";
      }, 3000);
    });
  });
});
