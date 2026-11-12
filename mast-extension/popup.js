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

const recentMeetingsList = document.getElementById('recentMeetingsList');
const dockedPillContainer = document.getElementById('dockedPillContainer');

const WORKER_BUILD_VERSION = '2.9';

let cachedPopupBaseBitmap = null;
let lastDetectedTeamsTab = { tabId: null, meetingTitle: 'Meeting', inActiveCall: false, pillDismissed: false };
let lastRecentSignature = null;
let localBottomState = null; // { mode: 'generating'|'done'|'error'|'update_required', text, progress, meetingId }
let localBottomTimer = null;
let latestStoredSnapshot = {};
let latestPopupBadgeToken = 0;

async function getPopupBaseBitmap() {
  if (cachedPopupBaseBitmap) return cachedPopupBaseBitmap;
  try {
    if (typeof fetch !== 'function' || typeof createImageBitmap !== 'function') return null;
    const res = await fetch(chrome.runtime.getURL('icons/icon128.png'));
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
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) {
    ctx.imageSmoothingQuality = 'high';
  }
  if (bitmap) {
    const iconBox = dotColor ? Math.round(size * 0.80) : size;
    ctx.drawImage(bitmap, 0, 0, iconBox, iconBox);
  }
  if (dotColor) {
    const r = size * 0.215;
    const ring = Math.max(0.9, size * 0.04);
    const cx = size * 0.74;
    const cy = size * 0.74;

    ctx.beginPath();
    ctx.arc(cx, cy, r + ring, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20, 20, 24, 0.96)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.fill();
  }
  return ctx.getImageData(0, 0, size, size);
}

async function syncToolbarAndHeaderDot(stored, inActiveCallFallback = false) {
  const token = ++latestPopupBadgeToken;
  const isTranscribing = !!(stored && stored.isTranscribing);
  const liveCaptionsOn = stored ? stored.liveCaptionsOn : true;
  const notesStatus = (stored && stored.notesStatus) || 'idle';
  const regenActive = !!(stored && stored.historyRegenProgress && stored.historyRegenProgress.active);
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
  } else if (notesStatus === 'generating' || regenActive || (localBottomState && localBottomState.mode === 'generating')) {
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
      if (token !== latestPopupBadgeToken) return;
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
          if (token !== latestPopupBadgeToken) return;
          const imageData = {
            16: renderPopupIconWithDot(bitmap, 16, dotColor),
            24: renderPopupIconWithDot(bitmap, 24, dotColor),
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

chrome.runtime.sendMessage({ action: 'get_worker_version' }, (res) => {
  void chrome.runtime.lastError;
  if (res && res.version && res.version !== WORKER_BUILD_VERSION && !localBottomState) {
    setLocalBottomState({ mode: 'update_required', text: 'Extension update pending' });
  }
});

if (settingsLink) {
  settingsLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.open(chrome.runtime.getURL('options.html'));
  });
}

function showApiKeySavedStatus(msg) {
  if (!statusEl) return;
  statusEl.innerText = msg;
  statusEl.style.color = '#30D158';
  statusEl.style.display = msg ? 'block' : 'none';
  if (msg) {
    setTimeout(() => {
      if (statusEl.innerText === msg) {
        statusEl.innerText = '';
        statusEl.style.display = 'none';
      }
    }, 2000);
  }
}

function setLocalBottomState(nextState, autoClearMs = 0) {
  if (localBottomTimer) {
    clearTimeout(localBottomTimer);
    localBottomTimer = null;
  }
  localBottomState = nextState;
  renderBottomDockedPill(latestStoredSnapshot);
  syncToolbarAndHeaderDot(latestStoredSnapshot, lastDetectedTeamsTab.inActiveCall);
  if (autoClearMs > 0 && nextState) {
    localBottomTimer = setTimeout(() => {
      if (localBottomState === nextState) {
        localBottomState = null;
        renderBottomDockedPill(latestStoredSnapshot);
        syncToolbarAndHeaderDot(latestStoredSnapshot, lastDetectedTeamsTab.inActiveCall);
      }
    }, autoClearMs);
  }
}

function formatCompactStage(rawStage) {
  const s = (rawStage || '').trim();
  if (!s || /generating/i.test(s)) return 'Generating notes';
  if (/connecting/i.test(s)) return 'Connecting...';
  if (/saving/i.test(s)) return 'Saving file';
  return s;
}

function updateDockedGeneratingProgressInPlace(progress, stage) {
  const fill = document.getElementById('dockedProgressFill');
  const pctEl = document.getElementById('dockedProgressPct');
  const stageEl = document.getElementById('dockedProgressStage');
  const pct = Math.max(0, Math.min(100, Math.round(typeof progress === 'number' ? progress : 0)));
  if (fill) fill.style.width = `${Math.max(6, pct)}%`;
  if (pctEl) pctEl.textContent = `${pct}%`;
  if (stageEl) stageEl.textContent = formatCompactStage(stage);
}

function createDockedIconHtml(type) {
  if (type === 'spinner') {
    return (
      '<svg class="mast-spin-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<circle cx="8" cy="8" r="6" stroke="rgba(139, 143, 248, 0.25)" stroke-width="2"/>' +
      '<path d="M14 8A6 6 0 0 0 8 2" stroke="#8B8FF8" stroke-width="2" stroke-linecap="round"/>' +
      '</svg>'
    );
  }
  if (type === 'check') {
    return (
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<circle cx="8" cy="8" r="7" fill="rgba(48, 209, 88, 0.18)" stroke="#30D158" stroke-width="1.4"/>' +
      '<path d="M5 8.2L7.1 10.3L11.2 6" stroke="#30D158" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>'
    );
  }
  if (type === 'error') {
    return (
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<circle cx="8" cy="8" r="7" fill="rgba(255, 69, 58, 0.18)" stroke="#FF453A" stroke-width="1.4"/>' +
      '<rect x="7.25" y="4.5" width="1.5" height="4.5" rx="0.75" fill="#FF453A"/>' +
      '<circle cx="8" cy="11.2" r="0.85" fill="#FF453A"/>' +
      '</svg>'
    );
  }
  return (
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M8 1.5L9.65 6.35L14.5 8L9.65 9.65L8 14.5L6.35 9.65L1.5 8L6.35 6.35L8 1.5Z" fill="#8B8FF8"/>' +
    '</svg>'
  );
}

function startCaptureFromDockedPill() {
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
        lastDetectedTeamsTab.pillDismissed = false;
        if (targetTabId) {
          chrome.tabs.sendMessage(targetTabId, { action: 'start' }, () => {
            void chrome.runtime.lastError;
          });
        }
        updateUI();
      }
    );
  });
}

function restoreFloatingPillToTeams() {
  const targetTabId = lastDetectedTeamsTab.tabId;
  lastDetectedTeamsTab.pillDismissed = false;
  chrome.storage.local.set({ pillDismissedInCall: false }, () => {
    if (targetTabId) {
      chrome.tabs.sendMessage(targetTabId, { action: 'restore_pill' }, () => {
        void chrome.runtime.lastError;
      });
    }
    updateUI();
  });
}

function renderBottomDockedPill(stored = {}) {
  if (!dockedPillContainer) return;

  // Determine effective state for the unified bottom docked pill
  let mode = null;
  let stageText = '';
  let pct = 0;
  let errorText = '';
  let retryMeetingId = null;

  if (localBottomState) {
    mode = localBottomState.mode;
    stageText = localBottomState.text || 'Generating notes...';
    pct = typeof localBottomState.progress === 'number' ? localBottomState.progress : 6;
    errorText = localBottomState.text || 'Notes failed';
    retryMeetingId = localBottomState.meetingId || null;
  } else if (stored.notesStatus === 'generating') {
    mode = 'generating';
    stageText = stored.notesStage || 'Generating notes...';
    pct = typeof stored.notesProgress === 'number' ? stored.notesProgress : 6;
  } else if (stored.notesStatus === 'error') {
    mode = 'error';
    errorText = stored.notesError ? `Notes failed (${stored.notesError})` : 'Notes generation failed';
  } else {
    const callActive = !!(lastDetectedTeamsTab.inActiveCall || stored.inActiveCall);
    const pillWasDismissed = !!(lastDetectedTeamsTab.pillDismissed || stored.pillDismissedInCall);
    if (callActive && !stored.isTranscribing && pillWasDismissed) {
      mode = 'dismissed_call';
    }
  }

  if (!mode) {
    dockedPillContainer.style.display = 'none';
    dockedPillContainer.removeAttribute('data-mode');
    dockedPillContainer.innerHTML = '';
    return;
  }

  // Fast in-place update if already showing generating mode
  if (mode === 'generating' && dockedPillContainer.getAttribute('data-mode') === 'generating') {
    dockedPillContainer.style.display = 'flex';
    updateDockedGeneratingProgressInPlace(pct, stageText);
    return;
  }

  dockedPillContainer.style.display = 'flex';
  dockedPillContainer.setAttribute('data-mode', mode);
  dockedPillContainer.removeAttribute('data-tone');
  dockedPillContainer.innerHTML = '';

  const left = document.createElement('div');
  left.className = 'docked-pill-left';

  const brand = document.createElement('span');
  brand.className = 'docked-pill-brand';

  const sep = document.createElement('span');
  sep.className = 'docked-pill-sep';

  if (mode === 'generating') {
    dockedPillContainer.setAttribute('data-tone', 'indigo');
    brand.innerHTML = createDockedIconHtml('spinner') + '<span>mast</span>';
    const clampedPct = Math.max(0, Math.min(100, Math.round(pct)));

    const textEl = document.createElement('span');
    textEl.id = 'dockedProgressStage';
    textEl.className = 'docked-pill-text';
    textEl.textContent = formatCompactStage(stageText);

    left.appendChild(brand);
    left.appendChild(sep);
    left.appendChild(textEl);

    const right = document.createElement('div');
    right.className = 'docked-pill-actions';

    const pctEl = document.createElement('span');
    pctEl.id = 'dockedProgressPct';
    pctEl.className = 'docked-pill-pct';
    pctEl.textContent = `${clampedPct}%`;

    const bar = document.createElement('div');
    bar.className = 'docked-pill-bar';
    const fill = document.createElement('div');
    fill.id = 'dockedProgressFill';
    fill.className = 'docked-pill-bar-fill';
    fill.style.width = `${Math.max(6, clampedPct)}%`;
    bar.appendChild(fill);

    right.appendChild(pctEl);
    right.appendChild(bar);

    dockedPillContainer.appendChild(left);
    dockedPillContainer.appendChild(right);
  } else if (mode === 'done') {
    dockedPillContainer.setAttribute('data-tone', 'green');
    brand.innerHTML = createDockedIconHtml('check') + '<span>mast</span>';

    const textEl = document.createElement('span');
    textEl.className = 'docked-pill-text';
    textEl.textContent = stageText || 'AI notes downloaded';

    left.appendChild(brand);
    left.appendChild(sep);
    left.appendChild(textEl);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'docked-pill-undock';
    closeBtn.title = 'Dismiss';
    closeBtn.textContent = '\u00D7';
    closeBtn.addEventListener('click', () => {
      setLocalBottomState(null);
    });

    dockedPillContainer.appendChild(left);
    dockedPillContainer.appendChild(closeBtn);
  } else if (mode === 'error') {
    dockedPillContainer.setAttribute('data-tone', 'red');
    brand.innerHTML = createDockedIconHtml('error') + '<span>mast</span>';

    const textEl = document.createElement('span');
    textEl.className = 'docked-pill-text';
    textEl.textContent = errorText;
    textEl.title = errorText;

    left.appendChild(brand);
    left.appendChild(sep);
    left.appendChild(textEl);

    const actions = document.createElement('div');
    actions.className = 'docked-pill-actions';

    const retryBtn = document.createElement('button');
    retryBtn.className = 'docked-pill-cta';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', () => {
      if (retryMeetingId) {
        triggerRecentMeetingNotes(retryMeetingId);
      } else {
        setLocalBottomState({ mode: 'generating', text: 'Connecting to Gemini...', progress: 6 });
        chrome.runtime.sendMessage({ action: 'generate_notes' }, () => {
          void chrome.runtime.lastError;
          setLocalBottomState(null);
          updateUI();
        });
      }
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'docked-pill-undock';
    closeBtn.title = 'Dismiss';
    closeBtn.textContent = '\u00D7';
    closeBtn.addEventListener('click', () => {
      if (localBottomState) {
        setLocalBottomState(null);
      } else {
        chrome.storage.local.set(
          { notesStatus: 'idle', notesError: '', notesProgress: 0, notesStage: '', completionUnseen: false },
          () => updateUI()
        );
      }
    });

    actions.appendChild(retryBtn);
    actions.appendChild(closeBtn);
    dockedPillContainer.appendChild(left);
    dockedPillContainer.appendChild(actions);
  } else if (mode === 'dismissed_call') {
    dockedPillContainer.setAttribute('data-tone', 'indigo');
    brand.innerHTML = createDockedIconHtml('sparkle') + '<span>mast</span>';

    const textEl = document.createElement('span');
    textEl.className = 'docked-pill-text';
    textEl.textContent = 'Meeting active';

    left.appendChild(brand);
    left.appendChild(sep);
    left.appendChild(textEl);

    const actions = document.createElement('div');
    actions.className = 'docked-pill-actions';

    const captureBtn = document.createElement('button');
    captureBtn.id = 'dockedCaptureBtn';
    captureBtn.className = 'docked-pill-cta';
    captureBtn.textContent = 'Capture';
    captureBtn.addEventListener('click', startCaptureFromDockedPill);

    const restoreBtn = document.createElement('button');
    restoreBtn.id = 'dockedRestoreBtn';
    restoreBtn.className = 'docked-pill-undock';
    restoreBtn.title = 'Pop out to Teams';
    restoreBtn.setAttribute('aria-label', 'Pop out to Teams');
    restoreBtn.innerHTML =
      '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M5 11L11 5M11 5H6.2M11 5V9.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
    restoreBtn.addEventListener('click', restoreFloatingPillToTeams);

    actions.appendChild(captureBtn);
    actions.appendChild(restoreBtn);
    dockedPillContainer.appendChild(left);
    dockedPillContainer.appendChild(actions);
  } else if (mode === 'update_required') {
    dockedPillContainer.setAttribute('data-tone', 'amber');
    brand.innerHTML = createDockedIconHtml('sparkle') + '<span>mast</span>';

    const textEl = document.createElement('span');
    textEl.className = 'docked-pill-text';
    textEl.textContent = stageText || 'Extension update pending';

    left.appendChild(brand);
    left.appendChild(sep);
    left.appendChild(textEl);

    const actions = document.createElement('div');
    actions.className = 'docked-pill-actions';

    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'docked-pill-cta';
    reloadBtn.textContent = 'Reload';
    reloadBtn.addEventListener('click', () => {
      try {
        chrome.runtime.reload();
      } catch (_) {}
    });

    actions.appendChild(reloadBtn);
    dockedPillContainer.appendChild(left);
    dockedPillContainer.appendChild(actions);
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
          showApiKeySavedStatus('API key saved');
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

function triggerRecentMeetingNotes(meetingId, btnEl = null) {
  if (btnEl) btnEl.disabled = true;
  setLocalBottomState({
    mode: 'generating',
    meetingId: String(meetingId),
    text: 'Connecting...',
    progress: 6
  });

  chrome.runtime.sendMessage({ action: 'regenerate_meeting_notes', meetingId }, (res) => {
    if (btnEl) btnEl.disabled = false;
    if (res && res.status === 'done') {
      setLocalBottomState({ mode: 'done', text: 'AI notes downloaded' }, 4500);
    } else if (res && res.error) {
      setLocalBottomState({
        mode: 'error',
        meetingId: String(meetingId),
        text: `Notes failed (${res.error})`
      });
    } else if (localBottomState && localBottomState.mode === 'generating') {
      setLocalBottomState({
        mode: 'error',
        meetingId: String(meetingId),
        text: 'Notes generation failed'
      });
    }
  });
}

function renderRecentMeetings(meetings, force = false) {
  if (!recentMeetingsList) return;
  const list = Array.isArray(meetings) ? meetings.slice(0, 4) : [];
  const sig = JSON.stringify(list.map((m) => ({ id: m.id, title: m.title, d: m.displayDate || m.shortDate })));
  if (!force && sig === lastRecentSignature) return;
  lastRecentSignature = sig;

  recentMeetingsList.innerHTML = '';

  if (list.length === 0) {
    recentMeetingsList.textContent = 'No recent meetings';
    return;
  }

  list.forEach((item) => {
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
      triggerRecentMeetingNotes(item.id, genBtn);
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
          setLocalBottomState({ mode: 'done', text: 'Transcript downloaded' }, 3500);
        } else if (res && res.error) {
          setLocalBottomState({ mode: 'error', text: res.error });
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
          renderRecentMeetings(res.recentMeetings, true);
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
  lastDetectedTeamsTab = {
    tabId: tabPresence.tabId || lastDetectedTeamsTab.tabId,
    meetingTitle: tabPresence.meetingTitle || 'Meeting',
    inActiveCall: !!tabPresence.inActiveCall,
    pillDismissed: !!tabPresence.pillDismissed
  };

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
      'historyRegenProgress',
      'completionUnseen',
      'recentMeetings'
    ],
    (result) => {
      if (chrome.runtime.lastError || !result) return;
      latestStoredSnapshot = result;

      if (result.completionUnseen) {
        chrome.storage.local.set({ completionUnseen: false });
      }

      const regenProg = result.historyRegenProgress;
      const regenFresh = regenProg && (!regenProg.updatedAt || Date.now() - regenProg.updatedAt < 90000);
      if (regenProg && regenProg.active && regenFresh) {
        localBottomState = {
          mode: 'generating',
          meetingId: regenProg.meetingId,
          text: formatCompactStage(regenProg.stage),
          progress: regenProg.progress || 6
        };
      } else if (regenProg && regenProg.active && !regenFresh) {
        chrome.storage.local.remove(['historyRegenProgress']);
      } else if (localBottomState && localBottomState.mode === 'generating' && regenProg && !regenProg.active) {
        if (regenProg.error) {
          setLocalBottomState({ mode: 'error', meetingId: regenProg.meetingId, text: `Notes failed (${regenProg.error})` });
        } else {
          setLocalBottomState({ mode: 'done', text: 'AI notes downloaded' }, 4500);
        }
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
      renderBottomDockedPill(result);

      if (result.notesStatus === 'generating') {
        chrome.runtime.sendMessage({ action: 'check_generation_status' }, () => {
          void chrome.runtime.lastError;
        });
      }
    }
  );
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes.historyRegenProgress) {
    const p = changes.historyRegenProgress.newValue;
    if (p && p.active) {
      setLocalBottomState({
        mode: 'generating',
        meetingId: p.meetingId,
        text: formatCompactStage(p.stage),
        progress: typeof p.progress === 'number' ? p.progress : 6
      });
    } else if (p && !p.active) {
      if (p.error) {
        setLocalBottomState({
          mode: 'error',
          meetingId: p.meetingId,
          text: `Notes failed (${p.error})`
        });
      } else if (localBottomState && localBottomState.mode === 'generating') {
        setLocalBottomState({ mode: 'done', text: 'AI notes downloaded' }, 4500);
      } else {
        setLocalBottomState(null);
      }
    } else if (!p && localBottomState && localBottomState.mode === 'generating') {
      setLocalBottomState(null);
    }
    if (Object.keys(changes).length === 1) {
      return;
    }
  }

  if ((changes.notesProgress || changes.notesStage) && Object.keys(changes).every((k) => k === 'notesProgress' || k === 'notesStage')) {
    if (changes.notesProgress) latestStoredSnapshot.notesProgress = changes.notesProgress.newValue;
    if (changes.notesStage) latestStoredSnapshot.notesStage = changes.notesStage.newValue;
    renderBottomDockedPill(latestStoredSnapshot);
    return;
  }

  updateUI();
});

document.addEventListener('DOMContentLoaded', () => {
  updateUI();
});
