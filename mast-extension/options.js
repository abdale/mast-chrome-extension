document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKey');
  const modelSelect = document.getElementById('modelSelect');
  const customModelContainer = document.getElementById('customModelContainer');
  const customModelInput = document.getElementById('customModel');
  const titleSourceSelect = document.getElementById('titleSource');
  const saveBtn = document.getElementById('saveBtn');
  const statusEl = document.getElementById('status');

  function getTopStableFlashModels(models) {
    const validModels = (models || []).filter(
      m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent")
    );

    const familyMap = new Map();
    for (const m of validModels) {
      const match = m.name.match(/^models\/gemini-(\d+)(?:\.(\d+))?-flash(?:-(\d{3}))?$/i);
      if (!match) continue;

      const major = parseInt(match[1], 10);
      const minor = match[2] !== undefined ? parseInt(match[2], 10) : 0;
      const rev = match[3] !== undefined ? parseInt(match[3], 10) : null;
      const familyKey = `${major}.${minor}`;

      const existing = familyMap.get(familyKey);
      if (!existing) {
        familyMap.set(familyKey, { model: m, major, minor, rev });
      } else if (rev === null && existing.rev !== null) {
        familyMap.set(familyKey, { model: m, major, minor, rev });
      } else if (rev !== null && existing.rev !== null && rev > existing.rev) {
        familyMap.set(familyKey, { model: m, major, minor, rev });
      }
    }

    const sorted = Array.from(familyMap.values()).sort((a, b) => {
      if (b.major !== a.major) return b.major - a.major;
      return b.minor - a.minor;
    });

    return sorted.slice(0, 2).map(entry => entry.model);
  }

  // Load saved settings
  chrome.storage.local.get(['apiKey', 'modelSelectVal', 'customModelVal', 'titleSource'], (result) => {
    if (result.apiKey) {
      apiKeyInput.value = result.apiKey;
      loadModels(result.apiKey, result.modelSelectVal);
    } else {
      modelSelect.innerHTML = '<option value="">Enter API Key to load models</option>';
    }
    
    if (result.customModelVal) {
      customModelInput.value = result.customModelVal;
    }

    if (titleSourceSelect) {
      titleSourceSelect.value = result.titleSource === 'teams' ? 'teams' : 'ai';
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
      const finalModels = getTopStableFlashModels(data.models);
      const validIds = finalModels.map(m => m.name.replace('models/', ''));
      
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
      
      if (selectedVal && (validIds.includes(selectedVal) || selectedVal === 'custom')) {
        modelSelect.value = selectedVal;
      } else {
        const defaultModelId = validIds[0] || 'custom';
        modelSelect.value = defaultModelId;
        if (defaultModelId !== 'custom') {
          chrome.storage.local.set({
            selectedModel: defaultModelId,
            modelSelectVal: defaultModelId
          });
        }
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
    const titleSource = titleSourceSelect ? titleSourceSelect.value : 'ai';
    
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
      customModelVal: customModelVal,
      titleSource: titleSource
    }, () => {
      statusEl.innerText = "Settings saved successfully!";
      statusEl.style.color = "#2e7d32";
      setTimeout(() => {
        statusEl.innerText = "";
      }, 3000);
    });
  });
});
