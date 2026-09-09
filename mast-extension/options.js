document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKey');
  const modelSelect = document.getElementById('modelSelect');
  const customModelContainer = document.getElementById('customModelContainer');
  const customModelInput = document.getElementById('customModel');
  const saveBtn = document.getElementById('saveBtn');
  const statusEl = document.getElementById('status');
  const refreshModelsBtn = document.getElementById('refreshModelsBtn');
  const refreshIcon = document.getElementById('refreshIcon');
  const modelHelpText = document.getElementById('modelHelpText');

  const FALLBACK_MODELS = [
    { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash (Recommended Default)', isRecommended: true },
    { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro (More Powerful / Slower)' },
    { id: 'gemini-2.0-flash', label: 'gemini-2.0-flash' },
    { id: 'gemini-1.5-flash', label: 'gemini-1.5-flash (Older Generation)' },
    { id: 'gemini-1.5-pro', label: 'gemini-1.5-pro (Older Generation Pro)' }
  ];

  // Helper to populate dropdown options with bias towards recent models
  function populateDropdown(models, selectedValue) {
    modelSelect.innerHTML = '';

    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      modelSelect.appendChild(opt);
    });

    const customOpt = document.createElement('option');
    customOpt.value = 'custom';
    customOpt.textContent = 'Custom Model...';
    modelSelect.appendChild(customOpt);

    // Identify the most recent recommended model
    const recommendedModel = models.find(m => m.isRecommended) || models[0];
    const defaultModelId = recommendedModel ? recommendedModel.id : 'gemini-2.5-flash';

    if (selectedValue && (models.some(m => m.id === selectedValue) || selectedValue === 'custom')) {
      modelSelect.value = selectedValue;
    } else {
      // Default biased towards the most recent model
      modelSelect.value = defaultModelId;
    }

    toggleCustomModelVisibility();
  }

  // Filter and sort raw API models with strong bias towards recent models
  function parseAndFilterModels(apiModels) {
    const eligible = apiModels.filter(m =>
      m.supportedGenerationMethods &&
      m.supportedGenerationMethods.includes('generateContent')
    );

    const parsed = [];
    const seenIds = new Set();

    for (const m of eligible) {
      const id = m.name.replace(/^models\//, '');
      const lower = id.toLowerCase();

      // Must be a Gemini family model
      if (!lower.startsWith('gemini')) continue;

      // Filter out non-text/specialized models
      if (lower.includes('imagen') || lower.includes('embed') ||
          lower.includes('tuning') || lower.includes('realtime') ||
          lower.includes('tts') || lower.includes('robotics')) {
        continue;
      }

      // Filter out -latest alias pointers to keep clean versioned IDs
      if (lower.endsWith('-latest')) continue;

      if (seenIds.has(id)) continue;
      seenIds.add(id);

      // Extract version number (e.g. gemini-2.5-flash -> 2.5)
      const versionMatch = lower.match(/gemini-(\d+(?:\.\d+)?)/i);
      const version = versionMatch ? parseFloat(versionMatch[1]) : 0;

      const isFlash = lower.includes('flash');
      const isLite = lower.includes('lite');
      const isPro = lower.includes('pro');
      const isStable = !lower.includes('exp') && !lower.includes('preview');

      parsed.push({
        id,
        version,
        isFlash,
        isLite,
        isPro,
        isStable,
        displayName: m.displayName || id
      });
    }

    // Sort: bias strongly towards recent models (version desc), stable over preview, flash over pro
    parsed.sort((a, b) => {
      // 1. Highest version first (e.g. 2.5 > 2.0 > 1.5)
      if (b.version !== a.version) return b.version - a.version;

      // 2. Stable release over experimental/preview
      if (a.isStable && !b.isStable) return -1;
      if (!a.isStable && b.isStable) return 1;

      // 3. Flash prioritized over Pro for transcription performance/cost
      if (a.isFlash && !b.isFlash) return -1;
      if (!a.isFlash && b.isFlash) return 1;

      // 4. Standard Flash before Flash-Lite
      if (!a.isLite && b.isLite) return -1;
      if (a.isLite && !b.isLite) return 1;

      return a.id.localeCompare(b.id);
    });

    if (parsed.length === 0) return [];

    // Find the latest stable Flash model to designate as the primary recommended default
    const maxVersion = parsed[0].version;
    const recommended = parsed.find(m => m.isStable && m.isFlash && !m.isLite) ||
                        parsed.find(m => m.isStable && m.isFlash) ||
                        parsed[0];

    // Build user-friendly labels with recency bias
    return parsed.map(m => {
      let label = m.id;
      if (m.id === recommended.id) {
        label = `${m.id} (Recommended Default)`;
      } else if (m.isPro && m.version >= maxVersion) {
        label = `${m.id} (More Powerful / Slower)`;
      } else if (m.isLite) {
        label = `${m.id} (Ultra Fast / Lightweight)`;
      } else if (!m.isStable) {
        label = `${m.id} (Preview / Experimental)`;
      } else if (m.version < maxVersion) {
        label = `${m.id} (Older Generation)`;
      } else if (m.displayName && !m.displayName.toLowerCase().includes(m.id.toLowerCase())) {
        label = `${m.id} (${m.displayName})`;
      }
      return { id: m.id, label, isRecommended: m.id === recommended.id };
    });
  }

  // Fetch models from Google AI Studio with caching & fallback
  async function fetchAndPopulateModels(apiKey, force = false, preferredSelectedVal = null) {
    if (!apiKey) {
      populateDropdown(FALLBACK_MODELS, preferredSelectedVal || modelSelect.value);
      if (modelHelpText) {
        modelHelpText.innerText = "Enter and save an API key to fetch latest models from Google AI Studio.";
      }
      return;
    }

    // Check cache first if not explicitly forced
    if (!force) {
      const cacheResult = await new Promise(resolve => {
        chrome.storage.local.get(['cachedModels', 'cachedModelsTime'], resolve);
      });
      const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
      if (cacheResult.cachedModels && cacheResult.cachedModels.length > 0 &&
          cacheResult.cachedModelsTime && (Date.now() - cacheResult.cachedModelsTime < CACHE_TTL)) {
        populateDropdown(cacheResult.cachedModels, preferredSelectedVal || modelSelect.value);
        if (modelHelpText) {
          modelHelpText.innerText = `Loaded ${cacheResult.cachedModels.length} models (cached). Click Refresh to check for newer models.`;
        }
        return;
      }
    }

    // Live API Fetch
    if (refreshModelsBtn) refreshModelsBtn.disabled = true;
    if (refreshIcon) refreshIcon.classList.add('spinning');
    if (modelHelpText) modelHelpText.innerText = "Fetching latest models from Google AI Studio...";

    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      if (!res.ok) {
        throw new Error(`Google API returned status ${res.status}`);
      }
      const data = await res.json();
      if (!data.models || !Array.isArray(data.models)) {
        throw new Error("Invalid response format from Gemini API");
      }

      const models = parseAndFilterModels(data.models);
      if (models.length === 0) {
        throw new Error("No generateContent models found");
      }

      // Save to cache
      chrome.storage.local.set({
        cachedModels: models,
        cachedModelsTime: Date.now()
      });

      populateDropdown(models, preferredSelectedVal || modelSelect.value);
      if (modelHelpText) {
        modelHelpText.innerText = `✓ Loaded ${models.length} Gemini models dynamically.`;
      }
    } catch (err) {
      console.warn("Failed to fetch models dynamically, falling back to cache/defaults:", err);
      chrome.storage.local.get(['cachedModels'], (result) => {
        const fallbackList = (result.cachedModels && result.cachedModels.length > 0) ? result.cachedModels : FALLBACK_MODELS;
        populateDropdown(fallbackList, preferredSelectedVal || modelSelect.value);
        if (modelHelpText) {
          modelHelpText.innerText = `⚠️ Could not reach Gemini API (${err.message}). Using fallback list.`;
        }
      });
    } finally {
      if (refreshModelsBtn) refreshModelsBtn.disabled = false;
      if (refreshIcon) refreshIcon.classList.remove('spinning');
    }
  }

  // Load saved settings on startup
  chrome.storage.local.get(['apiKey', 'modelSelectVal', 'customModelVal', 'cachedModels'], (result) => {
    if (result.apiKey) {
      apiKeyInput.value = result.apiKey;
    }

    if (result.customModelVal) {
      customModelInput.value = result.customModelVal;
    }

    // Render immediately from cache or fallback to avoid empty dropdown
    const initialList = (result.cachedModels && result.cachedModels.length > 0) ? result.cachedModels : FALLBACK_MODELS;
    const initialSelectedVal = result.modelSelectVal || null;
    populateDropdown(initialList, initialSelectedVal);

    // If API key is present, verify/refresh in the background if cache expired
    if (result.apiKey) {
      fetchAndPopulateModels(result.apiKey, false, initialSelectedVal);
    }
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

  // Refresh button click handler
  if (refreshModelsBtn) {
    refreshModelsBtn.addEventListener('click', () => {
      const key = apiKeyInput.value.trim();
      if (!key) {
        if (modelHelpText) {
          modelHelpText.innerText = "Please enter an API Key first before refreshing.";
        }
        return;
      }
      fetchAndPopulateModels(key, true, modelSelect.value);
    });
  }

  // Automatically fetch if user modifies API key and blurs/changes
  apiKeyInput.addEventListener('change', () => {
    const key = apiKeyInput.value.trim();
    if (key) {
      fetchAndPopulateModels(key, true, modelSelect.value);
    }
  });

  // Save settings handler
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

      // If user provided a key, ensure models are cached
      if (apiKey) {
        fetchAndPopulateModels(apiKey, false, modelSelectVal);
      }

      setTimeout(() => {
        statusEl.innerText = "";
      }, 3000);
    });
  });
});
