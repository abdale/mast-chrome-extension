document.addEventListener('DOMContentLoaded', () => {
  const WORKER_BUILD_VERSION = '2.8.1';
  chrome.runtime.sendMessage({ action: 'get_worker_version' }, (res) => {
    if (chrome.runtime.lastError || !res || res.version !== WORKER_BUILD_VERSION) {
      chrome.storage.local.set({ reopenOptionsAfterReload: true }, () => {
        chrome.runtime.reload();
      });
    }
  });

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
        'display: flex; justify-content: space-between; align-items: center; gap: 14px; padding: 12px 14px; background: #f8f9fa; border: 1px solid var(--border); border-radius: 8px;';

      const infoCol = document.createElement('div');
      infoCol.style.cssText = 'min-width: 0; flex: 1;';

      const titleEl = document.createElement('div');
      titleEl.style.cssText =
        'font-weight: 600; color: var(--text); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
      titleEl.textContent = item.title || 'Meeting';
      titleEl.title = item.title || 'Meeting';

      const dateEl = document.createElement('div');
      dateEl.style.cssText = 'font-size: 11.5px; color: var(--text-muted); margin-top: 3px;';
      dateEl.textContent = item.displayDate || item.shortDate || '';

      infoCol.appendChild(titleEl);
      infoCol.appendChild(dateEl);

      const actionsCol = document.createElement('div');
      actionsCol.style.cssText = 'display: flex; align-items: center; gap: 6px; flex-shrink: 0;';

      const pillBaseStyle =
        'color: var(--primary); background: #ffffff; border: 1px solid rgba(91, 95, 199, 0.35); padding: 5px 10px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 11.5px; white-space: nowrap; transition: all 0.15s ease;';

      const genLink = document.createElement('a');
      genLink.href = '#';
      genLink.textContent = 'Generate Notes';
      genLink.style.cssText = pillBaseStyle;

      genLink.addEventListener('mouseenter', () => {
        if (genLink.dataset.busy !== 'true') {
          genLink.style.background = 'rgba(91, 95, 199, 0.08)';
          genLink.style.borderColor = 'var(--primary)';
        }
      });
      genLink.addEventListener('mouseleave', () => {
        if (genLink.dataset.busy !== 'true') {
          genLink.style.background = '#ffffff';
          genLink.style.borderColor = 'rgba(91, 95, 199, 0.35)';
        }
      });

      genLink.addEventListener('click', (e) => {
        e.preventDefault();
        if (genLink.dataset.busy === 'true') return;
        genLink.dataset.busy = 'true';
        genLink.textContent = 'Generating...';
        genLink.style.color = 'var(--text-muted)';
        genLink.style.background = '#ffffff';
        genLink.style.borderColor = 'var(--border)';
        genLink.style.pointerEvents = 'none';

        chrome.runtime.sendMessage(
          { action: 'regenerate_meeting_notes', meetingId: item.id },
          (res) => {
            genLink.dataset.busy = 'false';
            genLink.style.pointerEvents = 'auto';
            if (res && res.status === 'done') {
              genLink.textContent = 'Downloaded';
              genLink.style.color = '#2e7d32';
              genLink.style.borderColor = 'rgba(46, 125, 50, 0.35)';
              setTimeout(() => {
                genLink.textContent = 'Generate Notes';
                genLink.style.color = 'var(--primary)';
                genLink.style.borderColor = 'rgba(91, 95, 199, 0.35)';
              }, 3000);
            } else {
              genLink.textContent = 'Retry';
              genLink.style.color = '#d32f2f';
              genLink.style.borderColor = 'rgba(211, 47, 47, 0.35)';
              if (res && res.error) {
                statusEl.innerText = `Error: ${res.error}`;
                statusEl.style.color = '#d32f2f';
              }
            }
          }
        );
      });

      const dlLink = document.createElement('a');
      dlLink.href = '#';
      dlLink.textContent = 'Transcript';
      dlLink.title = 'Download Transcript';
      dlLink.style.cssText = pillBaseStyle;

      dlLink.addEventListener('mouseenter', () => {
        if (dlLink.dataset.busy !== 'true') {
          dlLink.style.background = 'rgba(91, 95, 199, 0.08)';
          dlLink.style.borderColor = 'var(--primary)';
        }
      });
      dlLink.addEventListener('mouseleave', () => {
        if (dlLink.dataset.busy !== 'true') {
          dlLink.style.background = '#ffffff';
          dlLink.style.borderColor = 'rgba(91, 95, 199, 0.35)';
        }
      });

      dlLink.addEventListener('click', (e) => {
        e.preventDefault();
        if (dlLink.dataset.busy === 'true') return;
        dlLink.dataset.busy = 'true';
        dlLink.textContent = 'Saving...';
        dlLink.style.color = 'var(--text-muted)';
        dlLink.style.background = '#ffffff';
        dlLink.style.borderColor = 'var(--border)';
        dlLink.style.pointerEvents = 'none';

        chrome.runtime.sendMessage(
          { action: 'download_history_transcript', meetingId: item.id },
          (res) => {
            dlLink.dataset.busy = 'false';
            dlLink.style.pointerEvents = 'auto';
            if (res && res.status === 'downloaded') {
              dlLink.textContent = 'Saved';
              dlLink.style.color = '#2e7d32';
              dlLink.style.borderColor = 'rgba(46, 125, 50, 0.35)';
              setTimeout(() => {
                dlLink.textContent = 'Transcript';
                dlLink.style.color = 'var(--primary)';
                dlLink.style.borderColor = 'rgba(91, 95, 199, 0.35)';
              }, 2500);
            } else {
              dlLink.textContent = 'Transcript';
              dlLink.style.color = '#d32f2f';
              dlLink.style.borderColor = 'rgba(211, 47, 47, 0.35)';
              if (res && res.error) {
                statusEl.innerText = `Error: ${res.error}`;
                statusEl.style.color = '#d32f2f';
              }
            }
          }
        );
      });

      const delLink = document.createElement('a');
      delLink.href = '#';
      delLink.title = 'Delete meeting';
      delLink.textContent = '\u00D7';
      delLink.style.cssText =
        'color: var(--text-muted); text-decoration: none; font-size: 16px; font-weight: 600; line-height: 1; padding: 4px 6px; margin-left: 2px; border-radius: 5px; display: inline-flex; align-items: center; justify-content: center; transition: all 0.15s ease;';
      delLink.addEventListener('mouseenter', () => {
        delLink.style.color = '#d32f2f';
        delLink.style.background = 'rgba(211, 47, 47, 0.08)';
      });
      delLink.addEventListener('mouseleave', () => {
        delLink.style.color = 'var(--text-muted)';
        delLink.style.background = 'transparent';
      });
      delLink.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.runtime.sendMessage(
          { action: 'delete_recent_meeting', meetingId: item.id },
          (res) => {
            if (res && Array.isArray(res.recentMeetings)) {
              renderRecentMeetings(res.recentMeetings);
            }
          }
        );
      });

      actionsCol.appendChild(genLink);
      actionsCol.appendChild(dlLink);
      actionsCol.appendChild(delLink);

      row.appendChild(infoCol);
      row.appendChild(actionsCol);
      recentMeetingsList.appendChild(row);
    });
  }

  // Load saved settings
  chrome.storage.local.get(
    [
      'apiKey',
      'modelSelectVal',
      'customModelVal',
      'userSelectedModel',
      'titleSource',
      'recentMeetings',
      'savedTranscript',
      'meetingTitle',
      'startTime'
    ],
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

      let recent = Array.isArray(result.recentMeetings) ? result.recentMeetings : [];
      if (recent.length === 0 && Array.isArray(result.savedTranscript) && result.savedTranscript.length > 0) {
        const ts = result.startTime || Date.now();
        const dateObj = new Date(ts);
        const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const entry = {
          id: String(ts),
          title: result.meetingTitle || 'Meeting',
          teamsTitle: result.meetingTitle || 'Meeting',
          shortDate: `${months[dateObj.getMonth()]}${dateObj.getDate()}-${dateObj.getFullYear()}`,
          displayDate: dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          timestamp: ts,
          lines: result.savedTranscript
        };
        recent = [entry];
        chrome.storage.local.set({ recentMeetings: recent });
      }
      renderRecentMeetings(recent);

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
