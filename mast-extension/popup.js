const mainStatusDot = document.getElementById('mainStatusDot');
const settingsLink = document.getElementById('settingsLink');

const apiKeyInput = document.getElementById('apiKeyInput');
const validateBtn = document.getElementById('validateBtn');
const apiError = document.getElementById('apiError');
const statusEl = document.getElementById('status');

const modelSelect = document.getElementById('modelSelect');
const customModelContainer = document.getElementById('customModelContainer');
const customModelInput = document.getElementById('customModelInput');
const titleSourceToggle = document.getElementById('titleSourceToggle');
const hideCaptionBoxToggle = document.getElementById('hideCaptionBoxToggle');

const viewResults = document.getElementById('view-results');
const progressContainer = document.getElementById('progressContainer');
const progressBarFill = document.getElementById('progressBarFill');
const progressStageText = document.getElementById('progressStageText');
const progressPercentText = document.getElementById('progressPercentText');
const resultsErrorBox = document.getElementById('resultsErrorBox');
const resultsStatus = document.getElementById('resultsStatus');
const retryBtn = document.getElementById('retryBtn');
const dismissBtn = document.getElementById('dismissBtn');

const recentMeetingsList = document.getElementById('recentMeetingsList');
const dockedPillContainer = document.getElementById('dockedPillContainer');
const dockedCaptureBtn = document.getElementById('dockedCaptureBtn');
const dockedRestoreBtn = document.getElementById('dockedRestoreBtn');

const WORKER_BUILD_VERSION = '2.9-dev-9';

let cachedPopupBaseBitmap = null;
let lastDetectedTeamsTab = { tabId: null, meetingTitle: 'Meeting' };

async function getPopupBaseBitmap() {
  if (cachedPopupBaseBitmap) return cachedPopupBaseBitmap;
  try {
    if (typeof fetch !== 'function' || typeof createImageBitmap !== 'function') return null;
    const res = await fetch(chrome.runtime.getURL('icons/icon48.png'));
    const blob = await res.blob();
    cachedPopupBaseBitmap = await createImageBitmap(blob);
    return cachedPopupBaseBitmap;
  } catch (_) {
    return null;
  }
}

function renderPopupIconWithDot(bitmap, size, dotColor) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  if (bitmap) {
    ctx.drawImage(bitmap, 0, 0, size, size);
  }
  if (dotColor) {
    const r = Math.max(3.2, size * 0.215);
    const ring = Math.max(1.1, size * 0.065);
    const cx = size - r - ring * 0.5;
    const cy = size - r - ring * 0.5;

    ctx.beginPath();
    ctx.arc(cx, cy, r + ring, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20, 20, 24, 0.94)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.fill();
  }
  return ctx.getImageData(0, 0, size, size);
}

async function syncToolbarAndHeaderDot(stored, inActiveCallFallback = false) {
  const isTranscribing = !!(stored && stored.isTranscribing);
  const liveCaptionsOn = stored ? stored.liveCaptionsOn : true;
  const notesStatus = (stored && stored.notesStatus) || 'idle';
  const inActiveCall = !!(stored && stored.inActiveCall) || inActiveCallFallback;

  let dotColor = null;
  let tone = '';

  if (isTranscribing) {
    if (liveCaptionsOn === false) {
      dotColor = '#FF9F0A';
      tone = 'amber';
    } else {
      dotColor = '#30D158';
      tone = 'green';
    }
  } else if (notesStatus === 'generating') {
    dotColor = '#8B8FF8';
    tone = 'indigo';
  } else if (notesStatus === 'error') {
    dotColor = '#FF453A';
    tone = 'red';
  } else if (inActiveCall) {
    dotColor = '#8B8FF8';
    tone = 'indigo';
  }

  if (mainStatusDot) {
    if (tone) {
      mainStatusDot.setAttribute('data-tone', tone);
    } else {
      mainStatusDot.removeAttribute('data-tone');
    }
  }

  try {
    if (typeof chrome !== 'undefined' && chrome.action) {
      if (typeof chrome.action.setBadgeText === 'function') {
        await chrome.action.setBadgeText({ text: '' });
      }
      if (typeof chrome.action.setIcon === 'function') {
        if (!dotColor) {
          await chrome.action.setIcon({
            path: {
              16: 'icons/icon16.png',
              48: 'icons/icon48.png',
              128: 'icons/icon128.png'
            }
          });
        } else if (typeof OffscreenCanvas !== 'undefined') {
          const bitmap = await getPopupBaseBitmap();
          const imageData = {
            16: renderPopupIconWithDot(bitmap, 16, dotColor),
            32: renderPopupIconWithDot(bitmap, 32, dotColor),
            48: renderPopupIconWithDot(bitmap, 48, dotColor)
          };
          await chrome.action.setIcon({ imageData });
        }
      }
    }
  } catch (_) {}
}

// Clear any legacy text badge immediately on popup open
try {
  if (typeof chrome !== 'undefined' && chrome.action && typeof chrome.action.setBadgeText === 'function') {
    chrome.action.setBadgeText({ text: '' });
  }
} catch (_) {}

chrome.runtime.sendMessage({ action: 'get_worker_version' }, () => {
  void chrome.runtime.lastError;
});

if (settingsLink) {
  settingsLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.open(chrome.runtime.getURL('options.html'));
  });
}

function showTransientStatus(msg, isError = false) {
  if (!statusEl) return;
  statusEl.innerText = msg;
  statusEl.style.color = isError ? '#ff6961' : '#30D158';
  statusEl.style.display = msg ? 'block' : 'none';
  if (msg && !isError) {
    setTimeout(() => {
      if (statusEl.innerText === msg) {
        statusEl.innerText = '';
        statusEl.style.display = 'none';
      }
    }, 2200);
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

function toggleCustomModelVisibility() {
  if (!customModelContainer || !modelSelect) return;
  customModelContainer.style.display = modelSelect.value === 'custom' ? 'flex' : 'none';
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

async function loadModelsForPopup(apiKey, selectedVal, userSelectedModel) {
  if (!modelSelect) return { valid: false, defaultModelId: 'gemini-2.5-flash' };
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!response.ok) return { valid: false, defaultModelId: null };
    const data = await response.json();

    modelSelect.innerHTML = '';
    modelSelect.disabled = false;
    const finalModels = getTopStableFlashModels(data.models);
    const validIds = finalModels.map((m) => m.name.replace('models/', ''));
    const defaultModelId = validIds.length >= 2 ? validIds[1] : (validIds[0] || 'gemini-2.5-flash');

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
    return { valid: true, defaultModelId };
  } catch (_) {
    setModelSelectLockedState('Error loading models');
    return { valid: false, defaultModelId: null };
  }
}

if (validateBtn) {
  validateBtn.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      apiError.innerText = 'Key cannot be empty.';
      apiError.style.display = 'block';
      return;
    }

    validateBtn.innerText = '...';
    validateBtn.disabled = true;
    apiError.style.display = 'none';

    chrome.storage.local.get(['selectedModel', 'modelSelectVal', 'userSelectedModel'], async (result) => {
      const loaded = await loadModelsForPopup(key, result.modelSelectVal, result.userSelectedModel);

      if (loaded.valid) {
        const updates = { apiKey: key };
        if (!result.selectedModel || result.modelSelectVal !== 'custom') {
          updates.selectedModel = loaded.defaultModelId || 'gemini-2.5-flash';
          updates.modelSelectVal = loaded.defaultModelId || 'gemini-2.5-flash';
        }
        chrome.storage.local.set(updates, () => {
          validateBtn.innerText = '\u2713';
          validateBtn.disabled = false;
          showTransientStatus('Saved');
          setTimeout(() => {
            if (validateBtn) validateBtn.innerText = 'Save';
          }, 1600);
          updateUI();
        });
      } else {
        apiError.innerText = 'Invalid API key. Please try again.';
        apiError.style.display = 'block';
        validateBtn.innerText = 'Save';
        validateBtn.disabled = false;
      }
    });
  });
}

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
    chrome.storage.local.set({ hideCaptionBox: !!hideCaptionBoxToggle.checked });
  });
}

function applyProgressUI(progress, stage) {
  const pct = Math.max(0, Math.min(100, Math.round(typeof progress === 'number' ? progress : 0)));
  if (progressBarFill) {
    progressBarFill.style.width = `${Math.max(4, pct)}%`;
  }
  if (progressStageText) {
    progressStageText.innerText = stage || 'Generating meeting notes...';
  }
  if (progressPercentText) {
    progressPercentText.innerText = `${pct}%`;
  }
}

function updateHistoryRegenCardProgress(progressState) {
  if (!progressState || !progressState.meetingId) return;
  const wrap = document.querySelector(`[data-regen-wrap="${progressState.meetingId}"]`);
  const fill = document.querySelector(`[data-regen-fill="${progressState.meetingId}"]`);
  if (!wrap || !fill) return;
  if (!progressState.active) {
    wrap.style.display = 'none';
    return;
  }
  const pct = Math.max(0, Math.min(100, Math.round(progressState.progress || 0)));
  wrap.style.display = 'block';
  fill.style.width = `${Math.max(4, pct)}%`;
}

function renderRecentMeetings(meetings) {
  if (!recentMeetingsList) return;
  recentMeetingsList.innerHTML = '';

  if (!Array.isArray(meetings) || meetings.length === 0) {
    recentMeetingsList.textContent = 'No recent meetings';
    return;
  }

  meetings.slice(0, 4).forEach((item) => {
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
    const shortDisplay = (item.displayDate || item.shortDate || '').replace(/,\s*\d{4}$/, '');
    dateEl.textContent = shortDisplay;

    info.appendChild(titleEl);
    if (shortDisplay) {
      info.appendChild(dateEl);
    }

    const actions = document.createElement('div');
    actions.className = 'recent-actions';

    const progressWrap = document.createElement('div');
    progressWrap.setAttribute('data-regen-wrap', String(item.id));
    progressWrap.style.display = 'none';

    const progressTrack = document.createElement('div');
    progressTrack.className = 'progress-track';
    progressTrack.style.marginTop = '3px';

    const progressFill = document.createElement('div');
    progressFill.className = 'progress-fill';
    progressFill.setAttribute('data-regen-fill', String(item.id));
    progressTrack.appendChild(progressFill);
    progressWrap.appendChild(progressTrack);

    // Sparkle icon button: Generate AI Notes
    const genBtn = document.createElement('button');
    genBtn.className = 'mini-icon-btn';
    genBtn.title = 'Generate AI Notes';
    genBtn.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M8 1.5L9.65 6.35L14.5 8L9.65 9.65L8 14.5L6.35 9.65L1.5 8L6.35 6.35L8 1.5Z" fill="currentColor"/>' +
      '</svg>';
    genBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (genBtn.disabled) return;
      genBtn.disabled = true;
      progressWrap.style.display = 'block';
      progressFill.style.width = '8%';
      chrome.runtime.sendMessage({ action: 'regenerate_meeting_notes', meetingId: item.id }, (res) => {
        genBtn.disabled = false;
        progressWrap.style.display = 'none';
        if (res && res.status === 'done') {
          showTransientStatus('Notes downloaded');
        } else if (res && res.error) {
          showTransientStatus(res.error, true);
        }
      });
    });

    // Download icon button: Download Transcript
    const dlBtn = document.createElement('button');
    dlBtn.className = 'mini-icon-btn';
    dlBtn.title = 'Download Transcript';
    dlBtn.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M8 2.5V10.5M8 10.5L5 7.5M8 10.5L11 7.5M3 13H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
    dlBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (dlBtn.disabled) return;
      dlBtn.disabled = true;
      chrome.runtime.sendMessage({ action: 'download_history_transcript', meetingId: item.id }, (res) => {
        dlBtn.disabled = false;
        if (res && res.status === 'downloaded') {
          showTransientStatus('Transcript saved');
        }
      });
    });

    // Delete (×) icon button
    const delBtn = document.createElement('button');
    delBtn.className = 'mini-icon-btn danger';
    delBtn.title = 'Delete';
    delBtn.textContent = '\u00D7';
    delBtn.style.fontSize = '14px';
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
    card.appendChild(progressWrap);
    recentMeetingsList.appendChild(card);
  });
}

async function checkTeamsTabPresence() {
  const emptyRes = { inActiveCall: false, pillDismissed: false, tabId: null, meetingTitle: 'Meeting' };
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let targetTab = null;

    if (activeTab && activeTab.id) {
      const tabUrl = (activeTab.url || '').toLowerCase();
      if (
        tabUrl.includes('teams.microsoft.com') ||
        tabUrl.includes('teams.live.com') ||
        tabUrl.includes('teams.cloud.microsoft')
      ) {
        targetTab = activeTab;
      }
    }

    if (!targetTab) {
      const teamsTabs = await chrome.tabs.query({
        url: [
          'https://teams.microsoft.com/*',
          'https://*.teams.microsoft.com/*',
          'https://teams.live.com/*',
          'https://*.teams.live.com/*',
          'https://teams.cloud.microsoft/*',
          'https://*.teams.cloud.microsoft/*'
        ]
      });
      if (teamsTabs && teamsTabs.length > 0) {
        targetTab = teamsTabs[0];
      }
    }

    if (!targetTab || !targetTab.id) return emptyRes;

    const msgStatus = await new Promise((resolve) => {
      chrome.tabs.sendMessage(targetTab.id, { action: 'get_status' }, (res) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(res || null);
        }
      });
    });

    if (!msgStatus) {
      chrome.scripting.executeScript(
        {
          target: { tabId: targetTab.id, allFrames: true },
          files: ['content.js']
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
      return { ...emptyRes, tabId: targetTab.id };
    }

    return {
      inActiveCall: !!msgStatus.inActiveCall,
      pillDismissed: !!msgStatus.pillDismissed,
      tabId: targetTab.id,
      meetingTitle: msgStatus.meetingTitle || 'Meeting'
    };
  } catch (_) {
    return emptyRes;
  }
}

let initializedModelsForKey = '';

async function updateUI() {
  const tabPresence = await checkTeamsTabPresence();
  if (tabPresence.tabId) {
    lastDetectedTeamsTab = {
      tabId: tabPresence.tabId,
      meetingTitle: tabPresence.meetingTitle || 'Meeting'
    };
  }

  chrome.storage.local.get(
    [
      'apiKey',
      'selectedModel',
      'modelSelectVal',
      'customModelVal',
      'userSelectedModel',
      'titleSource',
      'hideCaptionBox',
      'isTranscribing',
      'liveCaptionsOn',
      'inActiveCall',
      'pillDismissedInCall',
      'notesStatus',
      'notesError',
      'notesProgress',
      'notesStage',
      'completionUnseen',
      'recentMeetings'
    ],
    (result) => {
      if (chrome.runtime.lastError || !result) return;

      if (result.completionUnseen) {
        chrome.storage.local.set({ completionUnseen: false });
      }

      syncToolbarAndHeaderDot(result, tabPresence.inActiveCall);

      if (apiKeyInput && document.activeElement !== apiKeyInput) {
        apiKeyInput.value = result.apiKey || '';
      }

      if (result.apiKey) {
        if (result.apiKey !== initializedModelsForKey) {
          initializedModelsForKey = result.apiKey;
          loadModelsForPopup(result.apiKey, result.modelSelectVal, result.userSelectedModel);
        }
      } else {
        initializedModelsForKey = '';
        setModelSelectLockedState('Enter API Key');
      }

      if (customModelInput && document.activeElement !== customModelInput && result.customModelVal) {
        customModelInput.value = result.customModelVal;
      }

      if (titleSourceToggle) {
        titleSourceToggle.checked = result.titleSource ? result.titleSource !== 'teams' : true;
      }

      if (hideCaptionBoxToggle) {
        hideCaptionBoxToggle.checked = result.hideCaptionBox !== undefined ? !!result.hideCaptionBox : true;
      }

      renderRecentMeetings(Array.isArray(result.recentMeetings) ? result.recentMeetings : []);

      const callActive = !!(tabPresence.inActiveCall || result.inActiveCall);
      const pillWasDismissed = !!(tabPresence.pillDismissed || result.pillDismissedInCall);
      if (dockedPillContainer) {
        if (callActive && !result.isTranscribing && result.notesStatus !== 'generating' && pillWasDismissed) {
          dockedPillContainer.style.display = 'flex';
        } else {
          dockedPillContainer.style.display = 'none';
        }
      }

      if (result.notesStatus === 'generating') {
        if (viewResults) viewResults.style.display = 'block';
        if (progressContainer) progressContainer.style.display = 'block';
        if (resultsErrorBox) resultsErrorBox.style.display = 'none';
        applyProgressUI(result.notesProgress, result.notesStage);
        chrome.runtime.sendMessage({ action: 'check_generation_status' }, () => {
          void chrome.runtime.lastError;
        });
      } else if (result.notesStatus === 'error') {
        if (viewResults) viewResults.style.display = 'block';
        if (progressContainer) progressContainer.style.display = 'none';
        if (resultsErrorBox) resultsErrorBox.style.display = 'block';
        if (resultsStatus) {
          resultsStatus.innerText = result.notesError
            ? `Notes failed (${result.notesError})`
            : 'Transcript saved, but AI notes failed.';
        }
      } else {
        if (viewResults) viewResults.style.display = 'none';
        if (progressContainer) progressContainer.style.display = 'none';
        if (resultsErrorBox) resultsErrorBox.style.display = 'none';
      }
    }
  );
}

if (retryBtn) {
  retryBtn.addEventListener('click', () => {
    if (progressContainer) progressContainer.style.display = 'block';
    if (resultsErrorBox) resultsErrorBox.style.display = 'none';
    applyProgressUI(5, 'Connecting to Gemini...');
    chrome.runtime.sendMessage({ action: 'generate_notes' }, () => {
      void chrome.runtime.lastError;
      updateUI();
    });
  });
}

if (dismissBtn) {
  dismissBtn.addEventListener('click', () => {
    chrome.storage.local.set(
      {
        notesStatus: 'idle',
        notesError: '',
        notesProgress: 0,
        notesStage: '',
        completionUnseen: false
      },
      () => {
        updateUI();
      }
    );
  });
}

if (dockedCaptureBtn) {
  dockedCaptureBtn.addEventListener('click', () => {
    chrome.storage.local.get(['apiKey'], (stored) => {
      const hasKey = !!(stored && typeof stored.apiKey === 'string' && stored.apiKey.trim());
      if (!hasKey) {
        if (apiError) {
          apiError.innerText = 'Save your API key above to start capturing.';
          apiError.style.display = 'block';
        }
        if (apiKeyInput) apiKeyInput.focus();
        return;
      }

      const startTime = Date.now();
      const targetTabId = lastDetectedTeamsTab.tabId;
      const initialTitle =
        lastDetectedTeamsTab.meetingTitle && lastDetectedTeamsTab.meetingTitle !== 'Meeting'
          ? lastDetectedTeamsTab.meetingTitle
          : 'Meeting';

      chrome.storage.local.set(
        {
          savedTranscript: [],
          isTranscribing: true,
          startTime: startTime,
          issueDetected: false,
          activeTabId: targetTabId,
          pillDismissedInCall: false,
          notesStatus: 'idle',
          notesError: '',
          notesProgress: 0,
          notesStage: '',
          completionUnseen: false,
          transcriptDownloaded: false,
          callEnded: false,
          liveCaptionsOn: true,
          meetingTitle: initialTitle
        },
        () => {
          if (targetTabId) {
            chrome.tabs.sendMessage(targetTabId, { action: 'start' }, () => {
              void chrome.runtime.lastError;
            });
          }
          updateUI();
        }
      );
    });
  });
}

if (dockedRestoreBtn) {
  dockedRestoreBtn.addEventListener('click', () => {
    const targetTabId = lastDetectedTeamsTab.tabId;
    chrome.storage.local.set({ pillDismissedInCall: false }, () => {
      if (targetTabId) {
        chrome.tabs.sendMessage(targetTabId, { action: 'restore_pill' }, () => {
          void chrome.runtime.lastError;
        });
      }
      updateUI();
    });
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.historyRegenProgress && changes.historyRegenProgress.newValue) {
    updateHistoryRegenCardProgress(changes.historyRegenProgress.newValue);
  }
  updateUI();
});

document.addEventListener('DOMContentLoaded', () => {
  updateUI();
});
