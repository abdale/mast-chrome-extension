import {
  GEMMA_MODEL_ID,
  checkGemmaAvailability,
  downloadGemmaModel,
  clearCachedGemmaModel,
  generateNotesWithGemma,
  formatBytesGB
} from './gemma-engine.js';

const WORKER_BUILD_VERSION = '2.9-dev';
const LEGACY_NANO_MODEL_ID = 'gemini-nano';
const IS_BG_INFER_TAB = new URLSearchParams(window.location.search).get('bg_infer') === '1';

function normalizeSimMode(rawMode) {
  if (rawMode === 'low_disk' || rawMode === 'downloadable') return rawMode;
  return 'real';
}

// Register background bridge listener immediately so options.html?bg_infer=1 responds without delay
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'bridge_gemma_check' || request.action === 'bridge_nano_check') {
    checkGemmaAvailability(normalizeSimMode(request.simMode)).then(sendResponse);
    return true;
  }
  if (request.action === 'bridge_gemma_generate' || request.action === 'bridge_nano_generate') {
    generateNotesWithGemma(
      request.lines || [],
      request.dateFormatted || '',
      normalizeSimMode(request.simMode),
      (pct, stage) => {
        if (request.channel) {
          chrome.runtime.sendMessage(
            { action: 'bridge_gemma_progress', channel: request.channel, pct, stage },
            () => {
              void chrome.runtime.lastError;
            }
          );
        }
      }
    )
      .then((minutesText) => sendResponse({ ok: true, minutesText }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err.message || 'Generation failed.',
          code: err.code || '',
          reason: err.reason || ''
        })
      );
    return true;
  }
  return false;
});

function initOptionsPage() {
  if (!IS_BG_INFER_TAB) {
    chrome.runtime.sendMessage({ action: 'get_worker_version' }, (res) => {
      if (chrome.runtime.lastError || !res || res.version !== WORKER_BUILD_VERSION) {
        chrome.storage.local.set({ reopenOptionsAfterReload: true }, () => {
          chrome.runtime.reload();
        });
      }
    });
  }

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
  const devClearModelCacheLink = document.getElementById('devClearModelCacheLink');
  const devResetChoiceSettingsLink = document.getElementById('devResetChoiceSettingsLink');
  const devTranscriptInput = document.getElementById('devTranscriptInput');
  const devUploadTranscriptBtn = document.getElementById('devUploadTranscriptBtn');
  const devCopySummaryBtn = document.getElementById('devCopySummaryBtn');
  const devClearSummaryBtn = document.getElementById('devClearSummaryBtn');
  const devTranscriptMeta = document.getElementById('devTranscriptMeta');
  const devTranscriptProgressWrap = document.getElementById('devTranscriptProgressWrap');
  const devTranscriptProgressFill = document.getElementById('devTranscriptProgressFill');
  const devTranscriptStage = document.getElementById('devTranscriptStage');
  const devTranscriptPct = document.getElementById('devTranscriptPct');
  const devTranscriptError = document.getElementById('devTranscriptError');
  const devSummaryBox = document.getElementById('devSummaryBox');
  const devSummaryHeader = document.getElementById('devSummaryHeader');
  const devTranscriptOutput = document.getElementById('devTranscriptOutput');

  let currentSimMode = 'real';
  let currentAiMode = 'unconfigured'; // 'gemma' | 'cloud' | 'unconfigured'
  let lastApiKeyInvalid = false;

  function getEffectiveAiMode(storedState = {}) {
    if (storedState.aiMode === 'gemma' || storedState.aiMode === 'nano') return 'gemma';
    if (storedState.aiMode === 'cloud') return 'cloud';
    if (
      storedState.modelSelectVal === GEMMA_MODEL_ID ||
      storedState.selectedModel === GEMMA_MODEL_ID ||
      storedState.modelSelectVal === LEGACY_NANO_MODEL_ID ||
      storedState.selectedModel === LEGACY_NANO_MODEL_ID
    ) {
      return 'gemma';
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

  function updateNoKeyCalloutVisibility() {
    if (!noKeyCallout) return;
    const hasKeyText = !!(apiKeyInput && apiKeyInput.value.trim());
    noKeyCallout.style.display = !hasKeyText || lastApiKeyInvalid ? 'block' : 'none';
  }

  function applyAiModeUI(mode) {
    currentAiMode = mode;
    if (modeCardNano) modeCardNano.classList.toggle('selected', mode === 'gemma');
    if (modeCardCloud) modeCardCloud.classList.toggle('selected', mode === 'cloud');

    if (mode === 'gemma') {
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
      applyAiModeUI('gemma');
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
      applyAiModeUI('gemma');
      chrome.storage.local.set(
        {
          aiMode: 'gemma',
          selectedModel: GEMMA_MODEL_ID,
          modelSelectVal: GEMMA_MODEL_ID,
          userSelectedModel: true,
          onboardingCompleted: true
        },
        () => {
          statusEl.innerText = 'Switched to Gemma On-Device!';
          statusEl.style.color = '#2e7d32';
          setTimeout(() => {
            if (statusEl.innerText === 'Switched to Gemma On-Device!') {
              statusEl.innerText = '';
            }
          }, 3000);
        }
      );
    });
  }

  function renderDevSimPills(mode) {
    currentSimMode = normalizeSimMode(mode);
    devSimPills.forEach((pill) => {
      const pillMode = pill.getAttribute('data-sim-mode');
      pill.classList.remove('active', 'active-warn');
      if (pillMode === currentSimMode) {
        const isWarn = currentSimMode === 'low_disk';
        pill.classList.add(isWarn ? 'active-warn' : 'active');
      }
    });
  }

  devSimPills.forEach((pill) => {
    pill.addEventListener('click', () => {
      const mode = normalizeSimMode(pill.getAttribute('data-sim-mode'));
      renderDevSimPills(mode);
      const updates = { devNanoSimMode: mode };
      if (mode === 'low_disk' || mode === 'downloadable') {
        updates.aiMode = 'gemma';
        updates.selectedModel = GEMMA_MODEL_ID;
        updates.modelSelectVal = GEMMA_MODEL_ID;
        updates.userSelectedModel = true;
        updates.onboardingCompleted = true;
        applyAiModeUI('gemma');
      }
      chrome.storage.local.set(updates, () => {
        if (currentAiMode === 'gemma') {
          refreshNanoStatusBox();
        }
      });
    });
  });

  if (devClearModelCacheLink) {
    devClearModelCacheLink.addEventListener('click', async (e) => {
      e.preventDefault();
      devClearModelCacheLink.textContent = 'Clearing...';
      try {
        await clearCachedGemmaModel();
        statusEl.innerText = 'Cleared cached Gemma 4 E2B model.';
        statusEl.style.color = '#5B5FC7';
      } catch (err) {
        statusEl.innerText = `Clear cache error: ${err.message || err}`;
        statusEl.style.color = '#d32f2f';
      } finally {
        devClearModelCacheLink.textContent = 'Clear Cache';
        if (currentAiMode === 'gemma') {
          refreshNanoStatusBox();
        }
      }
    });
  }

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

  function formatShortDate(dateObj = new Date()) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    return `${months[dateObj.getMonth()]}${dateObj.getDate()}-${dateObj.getFullYear()}`;
  }

  function sanitizeFilenameTitle(rawTitle, fallback = 'meeting') {
    if (!rawTitle || typeof rawTitle !== 'string') return fallback;
    const sanitized = rawTitle
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .substring(0, 60);
    if (!sanitized || sanitized === 'title') return fallback;
    return sanitized;
  }

  function downloadMarkdownFile(content, filename) {
    const dataUrl = `data:text/markdown;charset=utf-8,${encodeURIComponent(content)}`;
    return new Promise((resolve, reject) => {
      chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(downloadId);
        }
      });
    });
  }

  // [DEV-ONLY] Transcript Upload & Summarize Tester
  function applyDevTranscriptProgress(pct, stage) {
    if (!devTranscriptProgressWrap) return;
    const clamped = Math.max(0, Math.min(100, Math.round(pct || 0)));
    devTranscriptProgressWrap.style.display = 'block';
    if (devTranscriptProgressFill) devTranscriptProgressFill.style.width = `${Math.max(4, clamped)}%`;
    if (devTranscriptStage) devTranscriptStage.textContent = stage || 'Summarizing...';
    if (devTranscriptPct) devTranscriptPct.textContent = `${clamped}%`;
  }

  function deriveTitleFromFilename(fileName) {
    const base = String(fileName || 'Uploaded Transcript')
      .replace(/\.[^.]+$/, '')
      .replace(/^transcript[_-\s]*/i, '')
      .replace(/[_-]+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\d{1,2}-\d{4}$/i, '')
      .replace(/[_-]+/g, ' ')
      .trim();
    return base || 'Uploaded Transcript';
  }

  if (devUploadTranscriptBtn && devTranscriptInput) {
    devUploadTranscriptBtn.addEventListener('click', () => {
      devTranscriptInput.click();
    });

    devTranscriptInput.addEventListener('change', async () => {
      const file = devTranscriptInput.files && devTranscriptInput.files[0];
      devTranscriptInput.value = '';
      if (!file) return;

      const rawText = await file.text();
      const lines = rawText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && l !== 'WEBVTT');

      if (lines.length === 0) {
        if (devTranscriptError) {
          devTranscriptError.textContent = 'The selected file contains no transcript text.';
          devTranscriptError.style.display = 'block';
        }
        return;
      }

      const kb = (rawText.length / 1024).toFixed(1);
      const derivedTitle = deriveTitleFromFilename(file.name);
      if (devTranscriptMeta) {
        devTranscriptMeta.textContent = `${file.name} (${lines.length} lines, ${kb} KB)`;
      }
      if (devTranscriptError) devTranscriptError.style.display = 'none';
      if (devSummaryBox) devSummaryBox.style.display = 'none';
      if (devCopySummaryBtn) devCopySummaryBtn.style.display = 'none';
      if (devClearSummaryBtn) devClearSummaryBtn.style.display = 'none';

      devUploadTranscriptBtn.disabled = true;
      devUploadTranscriptBtn.textContent = 'Summarizing...';
      applyDevTranscriptProgress(5, 'Preparing Gemma 4 E2B...');

      const startedAt = Date.now();
      const dateObj = new Date();
      const dateFormatted =
        dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) +
        ' at ' +
        dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) +
        ' UTC';

      try {
        let minutesText = await generateNotesWithGemma(
          lines,
          dateFormatted,
          currentSimMode,
          (pct, stage) => applyDevTranscriptProgress(pct, stage)
        );

        const hasTitle = derivedTitle && derivedTitle.toLowerCase() !== 'meeting';
        if (!minutesText.trimStart().startsWith('#')) {
          const headingTitle = hasTitle ? derivedTitle : 'Meeting Notes';
          minutesText = `# ${headingTitle}\n\n${minutesText.trimStart()}`;
        }

        applyDevTranscriptProgress(96, 'Saving Markdown file...');
        const sanitizedTitle = sanitizeFilenameTitle(hasTitle ? derivedTitle : 'meeting', 'meeting');
        const filename = `${sanitizedTitle}_${formatShortDate(dateObj)}.md`;
        await downloadMarkdownFile(minutesText, filename);

        if (devTranscriptProgressWrap) devTranscriptProgressWrap.style.display = 'none';
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        if (devSummaryHeader) {
          devSummaryHeader.textContent = `Saved as ${filename} (${secs}s)`;
        }
        if (devTranscriptOutput) {
          devTranscriptOutput.textContent = minutesText;
        }
        if (devSummaryBox) devSummaryBox.style.display = 'block';
        if (devCopySummaryBtn) devCopySummaryBtn.style.display = 'inline-flex';
        if (devClearSummaryBtn) devClearSummaryBtn.style.display = 'inline-flex';

        if (currentAiMode === 'gemma') {
          refreshNanoStatusBox();
        }
      } catch (err) {
        if (devTranscriptProgressWrap) devTranscriptProgressWrap.style.display = 'none';
        if (devTranscriptError) {
          devTranscriptError.textContent = err.message || 'Failed to generate summary.';
          devTranscriptError.style.display = 'block';
        }
        if (err && err.code === 'NANO_UNAVAILABLE') {
          applyAiModeUI('gemma');
        }
      } finally {
        devUploadTranscriptBtn.disabled = false;
        devUploadTranscriptBtn.textContent = 'Upload Transcript';
      }
    });
  }

  if (devCopySummaryBtn) {
    devCopySummaryBtn.addEventListener('click', async () => {
      const text = devTranscriptOutput ? devTranscriptOutput.textContent : '';
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        devCopySummaryBtn.textContent = 'Copied';
        setTimeout(() => {
          devCopySummaryBtn.textContent = 'Copy Summary';
        }, 2000);
      } catch (_) {}
    });
  }

  if (devClearSummaryBtn) {
    devClearSummaryBtn.addEventListener('click', () => {
      if (devSummaryBox) devSummaryBox.style.display = 'none';
      if (devTranscriptOutput) devTranscriptOutput.textContent = '';
      if (devTranscriptMeta) devTranscriptMeta.textContent = '';
      if (devTranscriptError) devTranscriptError.style.display = 'none';
      if (devCopySummaryBtn) devCopySummaryBtn.style.display = 'none';
      devClearSummaryBtn.style.display = 'none';
    });
  }

  if (window.location.hash === '#dev-transcript-test') {
    const devCard = document.getElementById('dev-transcript-test');
    if (devCard) {
      setTimeout(() => {
        devCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 150);
    }
  }

  function getUnavailableCardMarkup() {
    return (
      '<div class="nano-box-title">Not enough disk space</div>' +
      '<div>At least <strong>3 GB</strong> of free disk space is required for Gemma On-Device.</div>' +
      '<div class="nano-actions">' +
      '  <button type="button" id="recheckNanoSettingsBtn" class="inline-btn secondary">Re-check</button>' +
      '</div>'
    );
  }

  async function refreshNanoStatusBox() {
    if (!nanoStatusBox || currentAiMode !== 'gemma') return;

    const avail = await checkGemmaAvailability(currentSimMode);
    if (currentAiMode !== 'gemma') return;

    nanoStatusBox.className = 'nano-box';
    nanoStatusBox.style.display = 'block';

    if (avail.status === 'available') {
      nanoStatusBox.classList.add('ready');
      nanoStatusBox.innerHTML =
        '<div class="nano-box-title">Gemma 4 E2B (On-Device) is ready</div>' +
        '<div>Meetings will be summarized locally on your device.</div>';
      return;
    }

    if (avail.status === 'downloadable' || avail.status === 'downloading') {
      nanoStatusBox.classList.add('download');
      nanoStatusBox.innerHTML =
        '<button type="button" id="downloadNanoBtn" class="download-model-btn">Download Gemma 4 E2B (~2.3 GB)</button>' +
        '<div id="nanoDownloadProgressWrap" style="display: none; margin-top: 8px;">' +
        '  <div class="progress-track"><div id="nanoDownloadFill" class="progress-fill"></div></div>' +
        '  <div id="nanoDownloadLabel" style="font-size: 11.5px; color: var(--text-muted); margin-top: 5px;">Starting download...</div>' +
        '</div>';

      const dlBtn = document.getElementById('downloadNanoBtn');
      const wrap = document.getElementById('nanoDownloadProgressWrap');
      const fill = document.getElementById('nanoDownloadFill');
      const label = document.getElementById('nanoDownloadLabel');

      const attachRealDownload = async () => {
        if (dlBtn) {
          dlBtn.disabled = true;
          dlBtn.textContent = 'Downloading...';
        }
        if (wrap) wrap.style.display = 'block';
        try {
          await downloadGemmaModel(({ loaded, total, pct }) => {
            if (fill) fill.style.width = `${Math.max(4, pct)}%`;
            if (label) {
              label.style.color = 'var(--text-muted)';
              label.textContent = `Downloading Gemma 4 E2B — ${formatBytesGB(loaded)} / ${formatBytesGB(total)} (${pct}%)`;
            }
          });
          refreshNanoStatusBox();
        } catch (err) {
          if (dlBtn) {
            dlBtn.disabled = false;
            dlBtn.textContent = 'Retry Download';
          }
          if (label) {
            label.style.color = '#d32f2f';
            label.textContent = `Download failed: ${err.message || 'Check network or disk space.'}`;
          }
        }
      };

      if (avail.status === 'downloading') {
        attachRealDownload();
        return;
      }

      if (dlBtn) {
        dlBtn.addEventListener('click', async () => {
          if (currentSimMode === 'downloadable') {
            dlBtn.disabled = true;
            dlBtn.textContent = 'Downloading...';
            if (wrap) wrap.style.display = 'block';
            for (const pct of [5, 22, 46, 71, 90, 100]) {
              if (fill) fill.style.width = `${pct}%`;
              if (label) label.textContent = `Downloading Gemma 4 E2B (${pct}%)...`;
              await new Promise((r) => setTimeout(r, 380));
            }
            dlBtn.textContent = 'Downloaded (Simulated)';
            if (label) label.textContent = 'Simulated download complete.';
            return;
          }
          await attachRealDownload();
        });
      }
      return;
    }

    nanoStatusBox.classList.add('unavailable');
    nanoStatusBox.innerHTML = getUnavailableCardMarkup();

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
    if (currentAiMode === 'gemma') {
      refreshNanoStatusBox();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentAiMode === 'gemma') {
      refreshNanoStatusBox();
    }
  });

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
                applyAiModeUI('gemma');
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
      renderDevSimPills(result.devNanoSimMode);

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
        const entry = {
          id: String(ts),
          title: result.meetingTitle || 'Meeting',
          teamsTitle: result.meetingTitle || 'Meeting',
          shortDate: formatShortDate(dateObj),
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
      renderDevSimPills(changes.devNanoSimMode.newValue);
      if (currentAiMode === 'gemma') {
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
    statusEl.innerText = 'Loading available cloud models...';
    statusEl.style.color = '#5B5FC7';
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      if (!response.ok) throw new Error('Invalid API key or network error');
      const data = await response.json();

      lastApiKeyInvalid = false;
      updateNoKeyCalloutVisibility();

      modelSelect.innerHTML = '';
      const finalModels = getTopStableFlashModels(data.models);
      const validIds = finalModels.map((m) => m.name.replace('models/', ''));
      const defaultModelId = validIds.length >= 2 ? validIds[1] : (validIds[0] || 'custom');

      finalModels.forEach((m) => {
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
      statusEl.innerText = '';
    } catch (_) {
      lastApiKeyInvalid = true;
      updateNoKeyCalloutVisibility();
      statusEl.innerText = 'Invalid API key. Check your key or select Gemma On-Device above.';
      statusEl.style.color = '#d32f2f';
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
      statusEl.innerText = 'Please choose Gemma On-Device or Gemini Flash above.';
      statusEl.style.color = '#d32f2f';
      return;
    }

    if (currentAiMode === 'gemma') {
      statusEl.innerText = 'Saving settings...';
      statusEl.style.color = '#5B5FC7';
      chrome.storage.local.set(
        {
          aiMode: 'gemma',
          selectedModel: GEMMA_MODEL_ID,
          modelSelectVal: GEMMA_MODEL_ID,
          userSelectedModel: true,
          onboardingCompleted: true
        },
        () => {
          statusEl.innerText = 'Settings saved! Using Gemma On-Device.';
          statusEl.style.color = '#2e7d32';
          setTimeout(() => {
            statusEl.innerText = '';
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
        "Please enter a Google AI Studio API key, or select Gemma On-Device if you don't have one.";
      statusEl.style.color = '#d32f2f';
      return;
    }

    if (!modelSelectVal) {
      statusEl.innerText = 'Please enter a valid API key to select a cloud model, or select Gemma On-Device.';
      statusEl.style.color = '#d32f2f';
      return;
    }

    let selectedModel = modelSelectVal;
    if (modelSelectVal === 'custom') {
      if (!customModelVal) {
        statusEl.innerText = 'Error: Please enter a Custom Model ID.';
        statusEl.style.color = '#d32f2f';
        return;
      }
      selectedModel = customModelVal;
    }

    statusEl.innerText = 'Saving settings...';
    statusEl.style.color = '#5B5FC7';

    chrome.storage.local.set(
      {
        apiKey,
        aiMode: 'cloud',
        selectedModel,
        modelSelectVal,
        customModelVal,
        userSelectedModel: true,
        onboardingCompleted: true,
        titleSource
      },
      () => {
        statusEl.innerText = 'Settings saved successfully!';
        statusEl.style.color = '#2e7d32';
        setTimeout(() => {
          statusEl.innerText = '';
        }, 3000);
      }
    );
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initOptionsPage);
} else {
  initOptionsPage();
}
