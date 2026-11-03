document.addEventListener('DOMContentLoaded', () => {
  const WORKER_BUILD_VERSION = '2.9.2';
  const GEMINI_NANO_MODEL_ID = 'gemini-nano';

  chrome.runtime.sendMessage({ action: 'get_worker_version' }, (res) => {
    if (chrome.runtime.lastError || !res || res.version !== WORKER_BUILD_VERSION) {
      chrome.storage.local.set({ reopenOptionsAfterReload: true }, () => {
        chrome.runtime.reload();
      });
    }
  });

  const modeCardNano = document.getElementById('modeCardNano');
  const modeCardCloud = document.getElementById('modeCardCloud');
  const nanoSection = document.getElementById('nanoSection');
  const cloudSection = document.getElementById('cloudSection');
  const nanoStatusBox = document.getElementById('nanoStatusBox');

  const apiKeyInput = document.getElementById('apiKey');
  const noKeyCallout = document.getElementById('noKeyCallout');
  const switchToNanoInSettingsBtn = document.getElementById('switchToNanoInSettingsBtn');
  const modelSelect = document.getElementById('modelSelect');
  const customModelContainer = document.getElementById('customModelContainer');
  const customModelInput = document.getElementById('customModel');
  const titleSourceSelect = document.getElementById('titleSource');
  const saveBtn = document.getElementById('saveBtn');
  const statusEl = document.getElementById('status');
  const recentMeetingsList = document.getElementById('recentMeetingsList');

  const devSimPills = document.querySelectorAll('.dev-sim-pill[data-sim-mode]');
  const devResetChoiceSettingsLink = document.getElementById('devResetChoiceSettingsLink');

  let currentSimMode = 'real';
  let currentAiMode = 'unconfigured'; // 'nano' | 'cloud' | 'unconfigured'
  let lastApiKeyInvalid = false;

  function getEffectiveAiMode(storedState = {}) {
    if (storedState.aiMode === 'nano') return 'nano';
    if (storedState.aiMode === 'cloud') return 'cloud';
    if (
      storedState.modelSelectVal === GEMINI_NANO_MODEL_ID ||
      storedState.selectedModel === GEMINI_NANO_MODEL_ID
    ) {
      return 'nano';
    }
    if (
      storedState.onboardingCompleted !== false &&
      storedState.apiKey &&
      storedState.apiKey.trim()
    ) {
      return 'cloud';
    }
    return 'unconfigured';
  }

  function bindChromeUrls(root = document) {
    root.querySelectorAll('[data-chrome-url]').forEach((el) => {
      if (el.dataset.boundChromeUrl === 'true') return;
      el.dataset.boundChromeUrl = 'true';
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const url = el.getAttribute('data-chrome-url');
        if (url) {
          chrome.tabs.create({ url });
        }
      });
    });
  }

  function getLanguageModelNamespace() {
    if (typeof LanguageModel !== 'undefined') return LanguageModel;
    if (typeof self !== 'undefined' && self.LanguageModel) return self.LanguageModel;
    if (typeof self !== 'undefined' && self.ai && self.ai.languageModel) return self.ai.languageModel;
    return null;
  }

  async function diagnoseUnavailableReason(lm) {
    if (!lm) return 'unsupported';

    if (typeof lm.create === 'function') {
      try {
        const probeSession = await lm.create({
          expectedInputs: [{ type: 'text', languages: ['en'] }],
          expectedOutputs: [{ type: 'text', languages: ['en'] }]
        }).catch(async (firstErr) => {
          if (firstErr && firstErr.name === 'TypeError') {
            return await lm.create();
          }
          throw firstErr;
        });
        if (probeSession && typeof probeSession.destroy === 'function') {
          probeSession.destroy();
        }
      } catch (err) {
        const msg = String((err && err.message) || '');
        if (/enough\s+(disk\s+)?space|insufficient.*space|disk\s+space/i.test(msg)) {
          return 'low_disk';
        }
        if (/disabled|not\s+enabled|feature\s+flag|service\s+is\s+not\s+running|required\s+configuration|on-device\s+ai|policy/i.test(msg)) {
          return 'setting_off';
        }
        if (/gpu|not\s+eligible|unsupported/i.test(msg)) {
          return 'unsupported';
        }
      }
    }

    try {
      if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
        const est = await navigator.storage.estimate();
        if (est && typeof est.quota === 'number' && est.quota > 0) {
          const remaining = est.quota - (est.usage || 0);
          if (remaining < 22 * 1024 * 1024 * 1024) {
            return 'low_disk';
          }
        }
      }
    } catch (_) {}

    return 'unknown';
  }

  async function checkNanoAvailabilityLocal(simMode = 'real') {
    if (simMode === 'setting_off') {
      return { status: 'unavailable', simulated: true, reason: 'setting_off' };
    }
    if (simMode === 'low_disk') {
      return { status: 'unavailable', simulated: true, reason: 'low_disk' };
    }
    if (simMode === 'downloadable') {
      return { status: 'downloadable', simulated: true, reason: 'simulated_download' };
    }

    const lm = getLanguageModelNamespace();
    if (!lm) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'get_nano_availability', simMode }, (res) => {
          if (chrome.runtime.lastError || !res) {
            resolve({ status: 'unavailable', simulated: false, reason: 'unsupported' });
          } else {
            resolve(res);
          }
        });
      });
    }

    try {
      if (typeof lm.availability === 'function') {
        let raw;
        try {
          raw = await lm.availability({
            expectedInputs: [{ type: 'text', languages: ['en'] }],
            expectedOutputs: [{ type: 'text', languages: ['en'] }]
          });
        } catch (_) {
          raw = await lm.availability();
        }
        if (raw === 'available' || raw === 'readily') {
          return { status: 'available', simulated: false, reason: 'ok' };
        }
        if (raw === 'downloadable' || raw === 'after-download') {
          return { status: 'downloadable', simulated: false, reason: 'needs_download' };
        }
        if (raw === 'downloading') {
          return { status: 'downloading', simulated: false, reason: 'downloading' };
        }
        const reason = await diagnoseUnavailableReason(lm);
        return { status: 'unavailable', simulated: false, reason };
      }
      if (typeof lm.capabilities === 'function') {
        const caps = await lm.capabilities();
        if (caps && caps.available === 'readily') return { status: 'available', simulated: false, reason: 'ok' };
        if (caps && caps.available === 'after-download') return { status: 'downloadable', simulated: false, reason: 'needs_download' };
      }
    } catch (_) {}

    const reason = await diagnoseUnavailableReason(lm);
    return { status: 'unavailable', simulated: false, reason };
  }

  function updateNoKeyCalloutVisibility() {
    if (!noKeyCallout) return;
    const hasKeyText = !!(apiKeyInput && apiKeyInput.value.trim());
    noKeyCallout.style.display = !hasKeyText || lastApiKeyInvalid ? 'block' : 'none';
  }

  function applyAiModeUI(mode) {
    currentAiMode = mode;
    if (modeCardNano) modeCardNano.classList.toggle('selected', mode === 'nano');
    if (modeCardCloud) modeCardCloud.classList.toggle('selected', mode === 'cloud');

    if (mode === 'nano') {
      if (nanoSection) nanoSection.style.display = 'block';
      if (cloudSection) cloudSection.style.display = 'none';
      refreshNanoStatusBox();
    } else if (mode === 'cloud') {
      if (nanoSection) nanoSection.style.display = 'none';
      if (cloudSection) cloudSection.style.display = 'block';
      updateNoKeyCalloutVisibility();
      toggleCustomModelVisibility();
    } else {
      if (nanoSection) nanoSection.style.display = 'none';
      if (cloudSection) cloudSection.style.display = 'none';
    }
  }

  if (modeCardNano) {
    modeCardNano.addEventListener('click', () => {
      statusEl.innerText = '';
      applyAiModeUI('nano');
    });
  }

  if (modeCardCloud) {
    modeCardCloud.addEventListener('click', () => {
      statusEl.innerText = '';
      applyAiModeUI('cloud');
      const key = apiKeyInput.value.trim();
      if (key && modelSelect.options.length <= 1) {
        loadCloudModels(key, modelSelect.value, true);
      }
    });
  }

  if (switchToNanoInSettingsBtn) {
    switchToNanoInSettingsBtn.addEventListener('click', () => {
      applyAiModeUI('nano');
      chrome.storage.local.set(
        {
          aiMode: 'nano',
          selectedModel: GEMINI_NANO_MODEL_ID,
          modelSelectVal: GEMINI_NANO_MODEL_ID,
          userSelectedModel: true,
          onboardingCompleted: true
        },
        () => {
          statusEl.innerText = 'Switched to Gemini Nano (On-Device)!';
          statusEl.style.color = '#2e7d32';
          setTimeout(() => {
            if (statusEl.innerText === 'Switched to Gemini Nano (On-Device)!') {
              statusEl.innerText = '';
            }
          }, 3000);
        }
      );
    });
  }

  function renderDevSimPills(mode) {
    currentSimMode = mode || 'real';
    devSimPills.forEach((pill) => {
      const pillMode = pill.getAttribute('data-sim-mode');
      pill.classList.remove('active', 'active-warn');
      if (pillMode === currentSimMode) {
        const isWarn = currentSimMode === 'low_disk' || currentSimMode === 'setting_off';
        pill.classList.add(isWarn ? 'active-warn' : 'active');
      }
    });
  }

  devSimPills.forEach((pill) => {
    pill.addEventListener('click', () => {
      const mode = pill.getAttribute('data-sim-mode') || 'real';
      renderDevSimPills(mode);
      const updates = { devNanoSimMode: mode };
      if (mode === 'setting_off' || mode === 'low_disk' || mode === 'downloadable') {
        updates.aiMode = 'nano';
        updates.selectedModel = GEMINI_NANO_MODEL_ID;
        updates.modelSelectVal = GEMINI_NANO_MODEL_ID;
        updates.userSelectedModel = true;
        updates.onboardingCompleted = true;
        applyAiModeUI('nano');
      }
      chrome.storage.local.set(updates, () => {
        if (currentAiMode === 'nano') {
          refreshNanoStatusBox();
        }
      });
    });
  });

  if (devResetChoiceSettingsLink) {
    devResetChoiceSettingsLink.addEventListener('click', (e) => {
      e.preventDefault();
      apiKeyInput.value = '';
      lastApiKeyInvalid = false;
      modelSelect.innerHTML = '<option value="">Enter API Key to load cloud models</option>';
      chrome.storage.local.set(
        {
          aiMode: '',
          onboardingCompleted: false,
          selectedModel: '',
          modelSelectVal: ''
        },
        () => {
          applyAiModeUI('unconfigured');
          statusEl.innerText = 'Choice reset. Open popup or pick an AI model card above.';
          statusEl.style.color = '#5B5FC7';
        }
      );
    });
  }

  function getUnavailableCardMarkup(reason) {
    if (reason === 'setting_off') {
      return (
        '<div class="nano-box-title">On-Device AI is turned off</div>' +
        '<div>Turn on <strong>On-device AI</strong> in <a href="#" data-chrome-url="chrome://settings/system">Chrome System Settings</a>.</div>' +
        '<div class="nano-actions">' +
        '  <button type="button" class="inline-btn outline-primary" data-chrome-url="chrome://settings/system">Open System Settings</button>' +
        '  <button type="button" id="recheckNanoSettingsBtn" class="inline-btn secondary">Re-check</button>' +
        '</div>'
      );
    }
    if (reason === 'low_disk') {
      return (
        '<div class="nano-box-title">Not enough disk space</div>' +
        '<div>At least <strong>22 GB</strong> of free disk space is required for Gemini On-Device.</div>' +
        '<div class="nano-actions">' +
        '  <button type="button" id="recheckNanoSettingsBtn" class="inline-btn secondary">Re-check</button>' +
        '</div>'
      );
    }
    if (reason === 'unsupported') {
      return (
        '<div class="nano-box-title">Not supported on this device</div>' +
        '<div>Update Chrome at <a href="#" data-chrome-url="chrome://settings/help">chrome://settings/help</a> or select <strong>Gemini Flash</strong> above.</div>' +
        '<div class="nano-actions">' +
        '  <button type="button" id="recheckNanoSettingsBtn" class="inline-btn secondary">Re-check</button>' +
        '</div>'
      );
    }
    return (
      '<div class="nano-box-title">Gemini On-Device is unavailable</div>' +
      '<div>Turn on <strong>On-device AI</strong> in <a href="#" data-chrome-url="chrome://settings/system">Chrome System Settings</a> and ensure <strong>22 GB</strong> of free disk space.</div>' +
      '<div class="nano-actions">' +
      '  <button type="button" class="inline-btn outline-primary" data-chrome-url="chrome://settings/system">Open System Settings</button>' +
      '  <button type="button" id="recheckNanoSettingsBtn" class="inline-btn secondary">Re-check</button>' +
      '</div>'
    );
  }

  async function refreshNanoStatusBox() {
    if (!nanoStatusBox || currentAiMode !== 'nano') return;

    const avail = await checkNanoAvailabilityLocal(currentSimMode);
    if (currentAiMode !== 'nano') return;

    nanoStatusBox.className = 'nano-box';
    nanoStatusBox.style.display = 'block';

    if (avail.status === 'available') {
      nanoStatusBox.classList.add('ready');
      nanoStatusBox.innerHTML =
        '<div class="nano-box-title">Gemini Nano (On-Device) is ready</div>' +
        '<div>Meetings will be summarized locally on your device.</div>';
      return;
    }

    if (avail.status === 'downloadable' || avail.status === 'downloading') {
      nanoStatusBox.classList.add('download');
      nanoStatusBox.innerHTML =
        '<button type="button" id="downloadNanoBtn" class="download-model-btn">Download On-Device Model</button>' +
        '<div id="nanoDownloadProgressWrap" style="display: none; margin-top: 8px;">' +
        '  <div class="progress-track"><div id="nanoDownloadFill" class="progress-fill"></div></div>' +
        '  <div id="nanoDownloadLabel" style="font-size: 11.5px; color: var(--text-muted); margin-top: 5px;">Starting download...</div>' +
        '</div>';

      const dlBtn = document.getElementById('downloadNanoBtn');
      const wrap = document.getElementById('nanoDownloadProgressWrap');
      const fill = document.getElementById('nanoDownloadFill');
      const label = document.getElementById('nanoDownloadLabel');

      if (dlBtn) {
        dlBtn.addEventListener('click', async () => {
          dlBtn.disabled = true;
          dlBtn.textContent = 'Downloading...';
          if (wrap) wrap.style.display = 'block';

          if (currentSimMode === 'downloadable') {
            for (const pct of [5, 22, 46, 71, 90, 100]) {
              if (fill) fill.style.width = `${pct}%`;
              if (label) label.textContent = `Downloading model (${pct}%)...`;
              await new Promise((r) => setTimeout(r, 420));
            }
            dlBtn.textContent = 'Downloaded (Simulated)';
            if (label) label.textContent = 'Simulated download complete.';
            return;
          }

          const lm = getLanguageModelNamespace();
          if (!lm || typeof lm.create !== 'function') {
            refreshNanoStatusBox();
            return;
          }

          try {
            const session = await lm.create({
              expectedInputs: [{ type: 'text', languages: ['en'] }],
              expectedOutputs: [{ type: 'text', languages: ['en'] }],
              monitor(m) {
                m.addEventListener('downloadprogress', (e) => {
                  const ratio =
                    typeof e.loaded === 'number'
                      ? e.total && e.total > 0
                        ? e.loaded / e.total
                        : e.loaded
                      : 0;
                  const pct = Math.min(100, Math.max(0, Math.round(ratio * 100)));
                  if (fill) fill.style.width = `${Math.max(4, pct)}%`;
                  if (label) label.textContent = `Downloading model (${pct}%)...`;
                });
              }
            });
            if (session && typeof session.destroy === 'function') {
              session.destroy();
            }
            refreshNanoStatusBox();
          } catch (err) {
            dlBtn.disabled = false;
            dlBtn.textContent = 'Retry Download';
            if (label) {
              label.style.color = '#d32f2f';
              label.textContent = `Download failed: ${err.message || 'Check System Settings or disk space.'}`;
            }
          }
        });
      }
      return;
    }

    nanoStatusBox.classList.add('unavailable');
    nanoStatusBox.innerHTML = getUnavailableCardMarkup(avail.reason);

    bindChromeUrls(nanoStatusBox);
    const recheckBtn = document.getElementById('recheckNanoSettingsBtn');
    if (recheckBtn) {
      recheckBtn.addEventListener('click', async () => {
        recheckBtn.disabled = true;
        recheckBtn.textContent = 'Checking...';
        await new Promise((r) => setTimeout(r, 250));
        refreshNanoStatusBox();
      });
    }
  }

  window.addEventListener('focus', () => {
    if (currentAiMode === 'nano') {
      refreshNanoStatusBox();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentAiMode === 'nano') {
      refreshNanoStatusBox();
    }
  });

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

  function updateHistoryRegenCardProgress(progressState) {
    if (!progressState || !progressState.meetingId) return;
    const wrap = document.querySelector(`[data-regen-wrap="${progressState.meetingId}"]`);
    const fill = document.querySelector(`[data-regen-fill="${progressState.meetingId}"]`);
    const label = document.querySelector(`[data-regen-label="${progressState.meetingId}"]`);
    if (!wrap || !fill || !label) return;

    if (!progressState.active) {
      wrap.style.display = 'none';
      return;
    }

    const pct = Math.max(0, Math.min(100, Math.round(progressState.progress || 0)));
    wrap.style.display = 'block';
    fill.style.width = `${Math.max(4, pct)}%`;
    label.textContent = `${progressState.stage || 'Generating notes...'} (${pct}%)`;
  }

  function renderRecentMeetings(meetings) {
    if (!recentMeetingsList) return;
    recentMeetingsList.innerHTML = '';

    if (!Array.isArray(meetings) || meetings.length === 0) {
      recentMeetingsList.textContent = 'No recent meetings recorded yet.';
      return;
    }

    meetings.slice(0, 5).forEach((item) => {
      const card = document.createElement('div');
      card.style.cssText =
        'display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; background: #f8f9fa; border: 1px solid var(--border); border-radius: 8px;';

      const row = document.createElement('div');
      row.style.cssText =
        'display: flex; justify-content: space-between; align-items: center; gap: 14px;';

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

      const progressWrap = document.createElement('div');
      progressWrap.setAttribute('data-regen-wrap', String(item.id));
      progressWrap.style.cssText = 'display: none;';

      const progressTrack = document.createElement('div');
      progressTrack.className = 'progress-track';
      progressTrack.style.marginTop = '2px';

      const progressFill = document.createElement('div');
      progressFill.className = 'progress-fill';
      progressFill.setAttribute('data-regen-fill', String(item.id));
      progressTrack.appendChild(progressFill);

      const progressLabel = document.createElement('div');
      progressLabel.setAttribute('data-regen-label', String(item.id));
      progressLabel.style.cssText = 'font-size: 11px; color: var(--text-muted); margin-top: 4px;';
      progressLabel.textContent = 'Preparing...';

      progressWrap.appendChild(progressTrack);
      progressWrap.appendChild(progressLabel);

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
        progressWrap.style.display = 'block';
        progressFill.style.width = '5%';
        progressLabel.textContent = 'Preparing meeting notes... (5%)';

        chrome.runtime.sendMessage(
          { action: 'regenerate_meeting_notes', meetingId: item.id },
          (res) => {
            genLink.dataset.busy = 'false';
            genLink.style.pointerEvents = 'auto';
            progressWrap.style.display = 'none';
            if (res && res.status === 'done') {
              genLink.textContent = 'Downloaded';
              genLink.style.color = '#2e7d32';
              genLink.style.borderColor = 'rgba(46, 125, 50, 0.35)';
              statusEl.innerText = '';
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
              if (res && res.errorCode === 'nano_unavailable') {
                applyAiModeUI('nano');
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

      card.appendChild(row);
      card.appendChild(progressWrap);
      recentMeetingsList.appendChild(card);
    });
  }

  // Load saved settings
  chrome.storage.local.get(
    [
      'apiKey',
      'aiMode',
      'onboardingCompleted',
      'modelSelectVal',
      'customModelVal',
      'userSelectedModel',
      'titleSource',
      'recentMeetings',
      'savedTranscript',
      'meetingTitle',
      'startTime',
      'devNanoSimMode'
    ],
    (result) => {
      renderDevSimPills(result.devNanoSimMode || 'real');

      const effectiveMode = getEffectiveAiMode(result);

      if (result.apiKey && result.apiKey.trim() && result.onboardingCompleted !== false) {
        apiKeyInput.value = result.apiKey;
        loadCloudModels(result.apiKey.trim(), result.modelSelectVal, result.userSelectedModel);
      } else {
        modelSelect.innerHTML = '<option value="">Enter API Key to load cloud models</option>';
      }

      if (result.customModelVal) {
        customModelInput.value = result.customModelVal;
      }

      if (titleSourceSelect) {
        titleSourceSelect.value = result.titleSource === 'teams' ? 'teams' : 'ai';
      }

      applyAiModeUI(effectiveMode);

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
    if (changes.devNanoSimMode) {
      renderDevSimPills(changes.devNanoSimMode.newValue || 'real');
      if (currentAiMode === 'nano') {
        refreshNanoStatusBox();
      }
    }
  });

  apiKeyInput.addEventListener('input', () => {
    lastApiKeyInvalid = false;
    updateNoKeyCalloutVisibility();
  });

  apiKeyInput.addEventListener('change', () => {
    const key = apiKeyInput.value.trim();
    updateNoKeyCalloutVisibility();
    if (key) {
      loadCloudModels(key, modelSelect.value, true);
    } else {
      statusEl.innerText = '';
      modelSelect.innerHTML = '<option value="">Enter API Key to load cloud models</option>';
      toggleCustomModelVisibility();
    }
  });

  async function loadCloudModels(apiKey, selectedVal, userSelectedModel) {
    statusEl.innerText = "Loading available cloud models...";
    statusEl.style.color = "#5B5FC7";
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      if (!response.ok) throw new Error("Invalid API key or network error");
      const data = await response.json();

      lastApiKeyInvalid = false;
      updateNoKeyCalloutVisibility();

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
      }

      toggleCustomModelVisibility();
      statusEl.innerText = "";
    } catch (e) {
      lastApiKeyInvalid = true;
      updateNoKeyCalloutVisibility();
      statusEl.innerText = "Invalid API key. Check your key or choose Gemini Nano (On-Device) above.";
      statusEl.style.color = "#d32f2f";
      modelSelect.innerHTML = '<option value="">Invalid API key</option>';
    }
  }

  function toggleCustomModelVisibility() {
    if (currentAiMode === 'cloud' && modelSelect.value === 'custom') {
      customModelContainer.style.display = 'block';
    } else {
      customModelContainer.style.display = 'none';
    }
  }

  modelSelect.addEventListener('change', toggleCustomModelVisibility);

  saveBtn.addEventListener('click', () => {
    const titleSource = titleSourceSelect ? titleSourceSelect.value : 'ai';

    if (currentAiMode === 'unconfigured') {
      statusEl.innerText = "Please choose Gemini On-Device or Gemini Flash above.";
      statusEl.style.color = "#d32f2f";
      return;
    }

    if (currentAiMode === 'nano') {
      statusEl.innerText = "Saving settings...";
      statusEl.style.color = "#5B5FC7";
      chrome.storage.local.set(
        {
          aiMode: 'nano',
          selectedModel: GEMINI_NANO_MODEL_ID,
          modelSelectVal: GEMINI_NANO_MODEL_ID,
          userSelectedModel: true,
          onboardingCompleted: true,
          titleSource: titleSource
        },
        () => {
          statusEl.innerText = "Settings saved! Using Gemini Nano (On-Device).";
          statusEl.style.color = "#2e7d32";
          setTimeout(() => {
            statusEl.innerText = "";
          }, 3000);
        }
      );
      return;
    }

    // Cloud mode
    const apiKey = apiKeyInput.value.trim();
    const modelSelectVal = modelSelect.value;
    const customModelVal = customModelInput.value.trim();

    if (!apiKey) {
      updateNoKeyCalloutVisibility();
      statusEl.innerText =
        "Please enter a Google AI Studio API key, or choose Gemini Nano (On-Device) if you don't have one.";
      statusEl.style.color = "#d32f2f";
      return;
    }

    if (!modelSelectVal) {
      statusEl.innerText = "Please enter a valid API key to select a cloud model, or choose Gemini Nano (On-Device).";
      statusEl.style.color = "#d32f2f";
      return;
    }

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

    chrome.storage.local.set(
      {
        apiKey: apiKey,
        aiMode: 'cloud',
        selectedModel: selectedModel,
        modelSelectVal: modelSelectVal,
        customModelVal: customModelVal,
        userSelectedModel: true,
        onboardingCompleted: true,
        titleSource: titleSource
      },
      () => {
        statusEl.innerText = "Settings saved successfully!";
        statusEl.style.color = "#2e7d32";
        setTimeout(() => {
          statusEl.innerText = "";
        }, 3000);
      }
    );
  });
});
