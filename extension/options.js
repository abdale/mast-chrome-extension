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
      loadModels(result.apiKey, result.modelSelectVal);
    } else {
      modelSelect.innerHTML = '<option value="">Enter API Key to load models</option>';
    }
    
    if (result.customModelVal) {
      customModelInput.value = result.customModelVal;
    }

    // Trigger initial visibility of custom model container
    toggleCustomModelVisibility();
  });

  apiKeyInput.addEventListener('change', () => {
    const key = apiKeyInput.value.trim();
    if (key) {
      loadModels(key, modelSelect.value);
    }
  });

  async function loadModels(apiKey, selectedVal) {
    statusEl.innerText = "Loading available models...";
    statusEl.style.color = "#5B5FC7";
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        if (!response.ok) throw new Error("Invalid API key or network error");
        const data = await response.json();
        
        modelSelect.innerHTML = '';
        const validModels = data.models.filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent"));
        
        // Helper to pick the latest/best model of a specific family
        function getLatestModel(keyword, excludeKeyword = null) {
            const matches = validModels.filter(m => {
                const name = m.name.toLowerCase();
                const hasKeyword = name.includes(keyword);
                const hasExclude = excludeKeyword ? name.includes(excludeKeyword) : false;
                return hasKeyword && !hasExclude && !name.includes('tuning') && !name.includes('embed');
            });
            // Prioritize standard/stable releases over preview/exp if available, then sort descending
            matches.sort((a, b) => {
                const aExp = a.name.includes('exp') || a.name.includes('preview');
                const bExp = b.name.includes('exp') || b.name.includes('preview');
                if (aExp && !bExp) return 1;
                if (!aExp && bExp) return -1;
                return b.name.localeCompare(a.name);
            });
            return matches[0];
        }

        const latestFlash = getLatestModel('flash', 'lite');
        const latestFlashLite = getLatestModel('flash-lite') || getLatestModel('flash_lite');
        const latestPro = getLatestModel('pro');
        
        const finalModels = [latestFlash, latestFlashLite, latestPro].filter(Boolean);
        
        finalModels.forEach(m => {
            const modelId = m.name.replace('models/', '');
            const option = document.createElement('option');
            option.value = modelId;
            option.textContent = m.displayName ? `${modelId} (${m.displayName})` : modelId;
            modelSelect.appendChild(option);
        });
        
        const customOpt = document.createElement('option');
        customOpt.value = 'custom';
        customOpt.textContent = 'Custom Model...';
        modelSelect.appendChild(customOpt);
        
        if (selectedVal && (finalModels.some(m => m.name.replace('models/', '') === selectedVal) || selectedVal === 'custom')) {
            modelSelect.value = selectedVal;
        } else {
            const defaultModel = latestFlash || finalModels[0];
            modelSelect.value = defaultModel ? defaultModel.name.replace('models/', '') : 'custom';
        }
        
        toggleCustomModelVisibility();
        statusEl.innerText = "";
    } catch (e) {
        statusEl.innerText = "Error loading models. Check API Key.";
        statusEl.style.color = "#d32f2f";
        modelSelect.innerHTML = '<option value="">Error loading models</option>';
    }
  }

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
