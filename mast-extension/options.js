document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKey');
  const modelSelect = document.getElementById('modelSelect');
  const customModelContainer = document.getElementById('customModelContainer');
  const customModelInput = document.getElementById('customModel');
  const titleSourceSelect = document.getElementById('titleSource');
  const saveBtn = document.getElementById('saveBtn');
  const statusEl = document.getElementById('status');
  const recentMeetingsList = document.getElementById('recentMeetingsList');

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

  function renderRecentMeetings(meetings) {
    if (!recentMeetingsList) return;
    recentMeetingsList.innerHTML = '';

    if (!Array.isArray(meetings) || meetings.length === 0) {
      recentMeetingsList.textContent = 'No recent meetings recorded yet.';
      return;
    }

    meetings.slice(0, 5).forEach((item) => {
      const row = document.createElement('div');
      row.style.cssText =
        'display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 8px 10px; background: #f8f9fa; border: 1px solid var(--border); border-radius: 6px;';

      const infoCol = document.createElement('div');
      infoCol.style.cssText = 'min-width: 0; flex: 1;';

      const titleEl = document.createElement('div');
      titleEl.style.cssText =
        'font-weight: 500; color: var(--text); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
      titleEl.textContent = item.title || 'Meeting';

      const dateEl = document.createElement('div');
      dateEl.style.cssText = 'font-size: 11px; color: var(--text-muted); margin-top: 2px;';
      dateEl.textContent = item.displayDate || item.shortDate || '';

      infoCol.appendChild(titleEl);
      infoCol.appendChild(dateEl);

      const genLink = document.createElement('a');
      genLink.href = '#';
      genLink.textContent = 'Generate';
      genLink.style.cssText =
        'color: var(--primary); text-decoration: none; font-weight: 600; font-size: 12px; white-space: nowrap; flex-shrink: 0;';

      genLink.addEventListener('click', (e) => {
        e.preventDefault();
        if (genLink.dataset.busy === 'true') return;
        genLink.dataset.busy = 'true';
        genLink.textContent = 'Generating...';
        genLink.style.color = 'var(--text-muted)';
        genLink.style.pointerEvents = 'none';

        chrome.runtime.sendMessage(
          { action: 'regenerate_meeting_notes', meetingId: item.id },
          (res) => {
            genLink.dataset.busy = 'false';
            genLink.style.pointerEvents = 'auto';
            if (res && res.status === 'done') {
              genLink.textContent = 'Downloaded';
              genLink.style.color = '#2e7d32';
              setTimeout(() => {
                genLink.textContent = 'Generate';
                genLink.style.color = 'var(--primary)';
              }, 3000);
            } else {
              genLink.textContent = 'Retry';
              genLink.style.color = '#d32f2f';
              if (res && res.error) {
                statusEl.innerText = `Error: ${res.error}`;
                statusEl.style.color = '#d32f2f';
              }
            }
          }
        );
      });

      row.appendChild(infoCol);
      row.appendChild(genLink);
      recentMeetingsList.appendChild(row);
    });
  }

  // Load saved settings
  chrome.storage.local.get(
    ['apiKey', 'modelSelectVal', 'customModelVal', 'userSelectedModel', 'titleSource', 'recentMeetings'],
    (result) => {
      if (result.apiKey) {
        apiKeyInput.value = result.apiKey;
        loadModels(result.apiKey, result.modelSelectVal, result.userSelectedModel);
      } else {
        modelSelect.innerHTML = '<option value="">Enter API Key to load models</option>';
      }

      if (result.customModelVal) {
        customModelInput.value = result.customModelVal;
      }

      if (titleSourceSelect) {
        titleSourceSelect.value = result.titleSource === 'teams' ? 'teams' : 'ai';
      }

      renderRecentMeetings(result.recentMeetings || []);

      // Trigger initial visibility of custom model container
      toggleCustomModelVisibility();
    }
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.recentMeetings) {
      renderRecentMeetings(changes.recentMeetings.newValue || []);
    }
  });

  apiKeyInput.addEventListener('change', () => {
    const key = apiKeyInput.value.trim();
    if (key) {
      loadModels(key, modelSelect.value, true);
    }
  });

  async function loadModels(apiKey, selectedVal, userSelectedModel) {
    statusEl.innerText = "Loading available models...";
    statusEl.style.color = "#5B5FC7";
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      if (!response.ok) throw new Error("Invalid API key or network error");
      const data = await response.json();

      modelSelect.innerHTML = '';
      const finalModels = getTopStableFlashModels(data.models);
      const validIds = finalModels.map(m => m.name.replace('models/', ''));
      const defaultModelId = validIds.length >= 2 ? validIds[1] : (validIds[0] || 'custom');

      finalModels.forEach(m => {
        const modelId = m.name.replace('models/', '');
        const option = document.createElement('option');
        option.value = modelId;
        const baseLabel = m.displayName || modelId;
        option.textContent = modelId === defaultModelId ? `${baseLabel} (Default)` : baseLabel;
        modelSelect.appendChild(option);
      });

      const customOpt = document.createElement('option');
      customOpt.value = 'custom';
      customOpt.textContent = 'Custom Model...';
      modelSelect.appendChild(customOpt);

      if (userSelectedModel && selectedVal && (validIds.includes(selectedVal) || selectedVal === 'custom')) {
        modelSelect.value = selectedVal;
      } else {
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
      userSelectedModel: true,
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
