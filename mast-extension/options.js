document.addEventListener('DOMContentLoaded', () => {
  const WORKER_BUILD_VERSION = '2.9-dev-11';
  try {
    if (typeof chrome !== 'undefined' && chrome.action && typeof chrome.action.setBadgeText === 'function') {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (_) {}
  chrome.runtime.sendMessage({ action: 'get_worker_version' }, () => {
    void chrome.runtime.lastError;
  });

  if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function') {
    navigator.storage
      .getDirectory()
      .then((root) => root.removeEntry('cache', { recursive: true }))
      .catch(() => {});
  }

  const apiKeyInput = document.getElementById('apiKey');
  const modelSelect = document.getElementById('modelSelect');
  const customModelContainer = document.getElementById('customModelContainer');
  const customModelInput = document.getElementById('customModel');
  const titleSourceToggle = document.getElementById('titleSourceToggle');
  const hideCaptionBoxToggle = document.getElementById('hideCaptionBoxToggle');
  const saveBtn = document.getElementById('saveBtn');
  const statusEl = document.getElementById('status');
  const recentMeetingsList = document.getElementById('recentMeetingsList');
  const dockedPillContainer = document.getElementById('dockedPillContainer');
  let dockedTimer = null;

  function renderOptionsDockedPill(state) {
    if (!dockedPillContainer) return;
    if (dockedTimer) {
      clearTimeout(dockedTimer);
      dockedTimer = null;
    }
    if (!state) {
      dockedPillContainer.style.display = 'none';
      dockedPillContainer.removeAttribute('data-mode');
      dockedPillContainer.innerHTML = '';
      return;
    }

    if (state.mode === 'generating' && dockedPillContainer.getAttribute('data-mode') === 'generating') {
      const pct = Math.max(0, Math.min(100, Math.round(state.progress || 6)));
      const fill = document.getElementById('optDockedFill');
      const pctEl = document.getElementById('optDockedPct');
      const stageEl = document.getElementById('optDockedStage');
      if (fill) fill.style.width = `${Math.max(6, pct)}%`;
      if (pctEl) pctEl.textContent = `${pct}%`;
      if (stageEl && state.text) stageEl.textContent = state.text;
      return;
    }

    dockedPillContainer.style.display = 'flex';
    dockedPillContainer.setAttribute('data-mode', state.mode);
    dockedPillContainer.setAttribute(
      'data-tone',
      state.mode === 'done' ? 'green' : state.mode === 'error' ? 'red' : 'indigo'
    );
    dockedPillContainer.innerHTML = '';

    const left = document.createElement('div');
    left.className = 'docked-pill-left';

    const brand = document.createElement('span');
    brand.className = 'docked-pill-brand';
    if (state.mode === 'generating') {
      brand.innerHTML =
        '<svg class="mast-spin-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<circle cx="8" cy="8" r="6" stroke="rgba(139, 143, 248, 0.25)" stroke-width="2"/>' +
        '<path d="M14 8A6 6 0 0 0 8 2" stroke="#8B8FF8" stroke-width="2" stroke-linecap="round"/>' +
        '</svg><span>mast</span>';
    } else if (state.mode === 'done') {
      brand.innerHTML =
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<circle cx="8" cy="8" r="7" fill="rgba(48, 209, 88, 0.18)" stroke="#30D158" stroke-width="1.4"/>' +
        '<path d="M5 8.2L7.1 10.3L11.2 6" stroke="#30D158" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg><span>mast</span>';
    } else {
      brand.innerHTML =
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<circle cx="8" cy="8" r="7" fill="rgba(255, 69, 58, 0.18)" stroke="#FF453A" stroke-width="1.4"/>' +
        '<rect x="7.25" y="4.5" width="1.5" height="4.5" rx="0.75" fill="#FF453A"/>' +
        '<circle cx="8" cy="11.2" r="0.85" fill="#FF453A"/>' +
        '</svg><span>mast</span>';
    }

    const sep = document.createElement('span');
    sep.className = 'docked-pill-sep';

    const textEl = document.createElement('span');
    textEl.id = 'optDockedStage';
    textEl.className = 'docked-pill-text';
    textEl.textContent = state.text || '';

    left.appendChild(brand);
    left.appendChild(sep);
    left.appendChild(textEl);
    dockedPillContainer.appendChild(left);

    if (state.mode === 'generating') {
      const pct = Math.max(0, Math.min(100, Math.round(state.progress || 6)));
      const right = document.createElement('div');
      right.className = 'docked-pill-actions';
      const pctEl = document.createElement('span');
      pctEl.id = 'optDockedPct';
      pctEl.className = 'docked-pill-pct';
      pctEl.textContent = `${pct}%`;
      const bar = document.createElement('div');
      bar.className = 'docked-pill-bar';
      const fill = document.createElement('div');
      fill.id = 'optDockedFill';
      fill.className = 'docked-pill-bar-fill';
      fill.style.width = `${Math.max(6, pct)}%`;
      bar.appendChild(fill);
      right.appendChild(pctEl);
      right.appendChild(bar);
      dockedPillContainer.appendChild(right);
    } else {
      const closeBtn = document.createElement('button');
      closeBtn.className = 'docked-pill-undock';
      closeBtn.title = 'Dismiss';
      closeBtn.textContent = '\u00D7';
      closeBtn.addEventListener('click', () => renderOptionsDockedPill(null));
      dockedPillContainer.appendChild(closeBtn);
      if (state.autoClearMs) {
        dockedTimer = setTimeout(() => renderOptionsDockedPill(null), state.autoClearMs);
      }
    }
  }

  function showStatus(msg, isError = false) {
    if (!statusEl) return;
    statusEl.innerText = msg;
    statusEl.style.color = isError ? '#ff6961' : '#30D158';
  }

  function setModelSelectLockedState(label = 'Enter API Key') {
    if (!modelSelect) return;
    modelSelect.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = label;
    modelSelect.appendChild(opt);
    modelSelect.disabled = true;
    if (customModelContainer) {
      customModelContainer.style.display = 'none';
    }
  }

  function getTopStableFlashModels(models) {
    const validModels = (models || []).filter(
      (m) => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent')
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

    return sorted.slice(0, 2).map((entry) => entry.model);
  }

  function updateHistoryRegenCardProgress(progressState) {
    if (!progressState || !progressState.active) return;
    renderOptionsDockedPill({
      mode: 'generating',
      text: progressState.stage || 'Generating notes...',
      progress: progressState.progress || 6
    });
  }

  function renderRecentMeetings(meetings) {
    if (!recentMeetingsList) return;
    recentMeetingsList.innerHTML = '';

    if (!Array.isArray(meetings) || meetings.length === 0) {
      recentMeetingsList.textContent = 'No recent meetings';
      return;
    }

    meetings.slice(0, 5).forEach((item) => {
      const card = document.createElement('div');
      card.className = 'recent-item';

      const row = document.createElement('div');
      row.className = 'recent-row';

      const info = document.createElement('div');
      info.className = 'recent-info';

      const titleEl = document.createElement('span');
      titleEl.className = 'recent-title';
      titleEl.textContent = item.title || 'Meeting';
      titleEl.title = item.title || 'Meeting';

      const dateEl = document.createElement('span');
      dateEl.className = 'recent-date';
      dateEl.textContent = item.displayDate || item.shortDate || '';

      info.appendChild(titleEl);
      info.appendChild(dateEl);

      const actions = document.createElement('div');
      actions.className = 'recent-actions';

      const genBtn = document.createElement('button');
      genBtn.className = 'mini-icon-btn';
      genBtn.title = 'Generate AI Notes';
      genBtn.innerHTML =
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M8 1.5L9.65 6.35L14.5 8L9.65 9.65L8 14.5L6.35 9.65L1.5 8L6.35 6.35L8 1.5Z" fill="currentColor"/>' +
        '</svg>';
      genBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (genBtn.disabled) return;
        genBtn.disabled = true;
        renderOptionsDockedPill({ mode: 'generating', text: 'Connecting to Gemini...', progress: 6 });
        chrome.runtime.sendMessage({ action: 'regenerate_meeting_notes', meetingId: item.id }, (res) => {
          genBtn.disabled = false;
          if (res && res.status === 'done') {
            renderOptionsDockedPill({ mode: 'done', text: 'AI notes downloaded', autoClearMs: 4500 });
          } else {
            renderOptionsDockedPill({
              mode: 'error',
              text: (res && res.error) ? `Notes failed (${res.error})` : 'Notes generation failed'
            });
          }
        });
      });

      const dlBtn = document.createElement('button');
      dlBtn.className = 'mini-icon-btn';
      dlBtn.title = 'Download Transcript';
      dlBtn.innerHTML =
        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M8 2.5V10.5M8 10.5L5 7.5M8 10.5L11 7.5M3 13H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>';
      dlBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (dlBtn.disabled) return;
        dlBtn.disabled = true;
        chrome.runtime.sendMessage({ action: 'download_history_transcript', meetingId: item.id }, (res) => {
          dlBtn.disabled = false;
          if (res && res.status === 'downloaded') {
            renderOptionsDockedPill({ mode: 'done', text: 'Transcript downloaded', autoClearMs: 3500 });
          } else if (res && res.error) {
            renderOptionsDockedPill({ mode: 'error', text: res.error });
          }
        });
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'mini-icon-btn danger';
      delBtn.title = 'Delete';
      delBtn.textContent = '\u00D7';
      delBtn.style.fontSize = '15px';
      delBtn.style.fontWeight = '600';
      delBtn.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.runtime.sendMessage({ action: 'delete_recent_meeting', meetingId: item.id }, (res) => {
          if (res && Array.isArray(res.recentMeetings)) {
            renderRecentMeetings(res.recentMeetings);
          }
        });
      });

      actions.appendChild(genBtn);
      actions.appendChild(dlBtn);
      actions.appendChild(delBtn);

      row.appendChild(info);
      row.appendChild(actions);

      card.appendChild(row);
      recentMeetingsList.appendChild(card);
    });
  }

  function toggleCustomModelVisibility() {
    if (!customModelContainer || !modelSelect) return;
    customModelContainer.style.display = modelSelect.value === 'custom' ? 'flex' : 'none';
  }

  async function loadModels(apiKey, selectedVal, userSelectedModel) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      if (!response.ok) throw new Error('Invalid API key');
      const data = await response.json();

      modelSelect.innerHTML = '';
      modelSelect.disabled = false;
      const finalModels = getTopStableFlashModels(data.models);
      const validIds = finalModels.map((m) => m.name.replace('models/', ''));
      const defaultModelId = validIds.length >= 2 ? validIds[1] : (validIds[0] || 'custom');

      finalModels.forEach((m) => {
        const modelId = m.name.replace('models/', '');
        const option = document.createElement('option');
        option.value = modelId;
        option.textContent = m.displayName || modelId;
        modelSelect.appendChild(option);
      });

      const customOpt = document.createElement('option');
      customOpt.value = 'custom';
      customOpt.textContent = 'Custom...';
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
      return true;
    } catch (_) {
      showStatus('Invalid API key. Please check and try again.', true);
      setModelSelectLockedState('Enter API Key');
      return false;
    }
  }

  // Load saved settings
  chrome.storage.local.get(
    [
      'apiKey',
      'modelSelectVal',
      'customModelVal',
      'userSelectedModel',
      'titleSource',
      'hideCaptionBox',
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
        setModelSelectLockedState('Enter API Key');
      }

      if (result.customModelVal && customModelInput) {
        customModelInput.value = result.customModelVal;
      }

      if (titleSourceToggle) {
        titleSourceToggle.checked = result.titleSource ? result.titleSource !== 'teams' : true;
      }

      if (hideCaptionBoxToggle) {
        hideCaptionBoxToggle.checked = result.hideCaptionBox !== undefined ? !!result.hideCaptionBox : true;
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

      toggleCustomModelVisibility();
    }
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.recentMeetings) {
      renderRecentMeetings(changes.recentMeetings.newValue || []);
    }
    if (changes.historyRegenProgress && changes.historyRegenProgress.newValue) {
      updateHistoryRegenCardProgress(changes.historyRegenProgress.newValue);
    }
    if (changes.titleSource && titleSourceToggle) {
      titleSourceToggle.checked = changes.titleSource.newValue !== 'teams';
    }
    if (changes.hideCaptionBox && hideCaptionBoxToggle) {
      hideCaptionBoxToggle.checked = changes.hideCaptionBox.newValue !== undefined ? !!changes.hideCaptionBox.newValue : true;
    }
  });

  if (modelSelect) {
    modelSelect.addEventListener('change', () => {
      toggleCustomModelVisibility();
      const val = modelSelect.value;
      if (val === 'custom') {
        const customVal = customModelInput ? customModelInput.value.trim() : '';
        chrome.storage.local.set({
          modelSelectVal: 'custom',
          selectedModel: customVal || 'gemini-2.5-flash',
          userSelectedModel: true
        });
      } else if (val) {
        chrome.storage.local.set({
          modelSelectVal: val,
          selectedModel: val,
          userSelectedModel: true
        });
      }
    });
  }

  if (customModelInput) {
    customModelInput.addEventListener('change', () => {
      const customVal = customModelInput.value.trim();
      if (customVal && modelSelect && modelSelect.value === 'custom') {
        chrome.storage.local.set({
          modelSelectVal: 'custom',
          customModelVal: customVal,
          selectedModel: customVal,
          userSelectedModel: true
        });
      }
    });
  }

  if (titleSourceToggle) {
    titleSourceToggle.addEventListener('change', () => {
      chrome.storage.local.set({
        titleSource: titleSourceToggle.checked ? 'ai' : 'teams'
      });
    });
  }

  if (hideCaptionBoxToggle) {
    hideCaptionBoxToggle.addEventListener('change', () => {
      chrome.storage.local.set({
        hideCaptionBox: !!hideCaptionBoxToggle.checked
      });
    });
  }

  saveBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    const titleSource = titleSourceToggle && !titleSourceToggle.checked ? 'teams' : 'ai';
    const hideCaptionBox = hideCaptionBoxToggle ? !!hideCaptionBoxToggle.checked : true;

    if (!apiKey) {
      showStatus('Please enter your Google AI Studio API key.', true);
      setModelSelectLockedState('Enter API Key');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.innerText = '...';

    const ok = await loadModels(apiKey, modelSelect.value, !!modelSelect.value);
    if (!ok) {
      saveBtn.disabled = false;
      saveBtn.innerText = 'Save';
      return;
    }

    const modelSelectVal = modelSelect.value;
    const customModelVal = customModelInput ? customModelInput.value.trim() : '';
    let selectedModel = modelSelectVal;

    if (modelSelectVal === 'custom') {
      if (!customModelVal) {
        showStatus('Please enter a Custom Model ID.', true);
        saveBtn.disabled = false;
        saveBtn.innerText = 'Save';
        return;
      }
      selectedModel = customModelVal;
    }

    chrome.storage.local.set(
      {
        apiKey: apiKey,
        selectedModel: selectedModel,
        modelSelectVal: modelSelectVal,
        customModelVal: customModelVal,
        userSelectedModel: true,
        titleSource: titleSource,
        hideCaptionBox: hideCaptionBox
      },
      () => {
        saveBtn.disabled = false;
        saveBtn.innerText = '\u2713';
        showStatus('Settings saved!');
        setTimeout(() => {
          if (saveBtn) saveBtn.innerText = 'Save';
          showStatus('');
        }, 2200);
      }
    );
  });
});
