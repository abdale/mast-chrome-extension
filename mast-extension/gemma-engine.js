// On-Device Gemma 4 E2B-IT Engine (Single-Pass 128K Context, WebGPU + Multi-Threaded WASM64 SIMD CPU)
import { Wllama, ModelManager } from './vendor/wllama/wllama.js';

export const GEMMA_MODEL_ID = 'gemma-4-e2b-it';
export const GEMMA_MODEL_LABEL = 'Gemma 4 E2B (On-Device)';
export const GEMMA_MODEL_URL =
  'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q3_K_S.gguf';
export const GEMMA_EXPECTED_BYTES = 2445652064; // ~2.28 GiB (2.45 GB)
export const MIN_FREE_DISK_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB

const WASM_URL = new URL('./vendor/wllama/wllama.wasm', import.meta.url).href;
const IDLE_UNLOAD_MS = 5 * 60 * 1000;
const MAX_MODEL_CTX = 131072; // Gemma 4 E2B native 128K context window
const MAX_SINGLE_PASS_CHARS = 420000; // ~115K tokens (+ output headroom inside 128K)

const GEMMA_SYSTEM_PROMPT =
  'You are an expert meeting minutes generator. Produce clear, accurate, concise Markdown meeting notes strictly grounded in the provided transcript. Never invent facts, attendees, or action items.';

let sharedModelManager = null;
let activeDownloadPromise = null;
const downloadProgressListeners = new Set();

let warmRuntime = null; // { wllama, hasWebGPU, nCtx }
let idleUnloadTimer = null;
let inferenceQueue = Promise.resolve();

function getModelManager() {
  if (!sharedModelManager) {
    sharedModelManager = new ModelManager({ parallelDownloads: 1 });
  }
  return sharedModelManager;
}

export function formatBytesGB(bytes) {
  const gb = Math.max(0, Number(bytes) || 0) / (1024 * 1024 * 1024);
  return `${gb.toFixed(2)} GB`;
}

export async function detectWebGPU() {
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.gpu &&
      typeof navigator.gpu.requestAdapter === 'function'
    ) {
      const adapter = await navigator.gpu.requestAdapter({
        powerPreference: 'high-performance'
      });
      if (adapter) return true;
    }
  } catch (_) {}
  return false;
}

export async function getCachedGemmaModel() {
  try {
    const mm = getModelManager();
    const models = await mm.getModels();
    const match = models.find((m) => m.url === GEMMA_MODEL_URL);
    if (match && match.size > 2000000000) {
      return match;
    }
  } catch (_) {}
  return null;
}

export async function checkGemmaAvailability(simMode = 'real') {
  if (simMode === 'low_disk') {
    return { status: 'unavailable', simulated: true, reason: 'low_disk' };
  }
  if (simMode === 'downloadable') {
    return { status: 'downloadable', simulated: true, reason: 'simulated_download' };
  }

  const [cachedModel, hasWebGPU] = await Promise.all([
    getCachedGemmaModel(),
    detectWebGPU()
  ]);

  if (cachedModel) {
    return {
      status: 'available',
      simulated: false,
      reason: 'ok',
      sizeBytes: cachedModel.size,
      hasWebGPU
    };
  }

  if (activeDownloadPromise) {
    return {
      status: 'downloading',
      simulated: false,
      reason: 'downloading',
      hasWebGPU
    };
  }

  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.storage &&
      typeof navigator.storage.estimate === 'function'
    ) {
      const est = await navigator.storage.estimate();
      if (est && typeof est.quota === 'number' && est.quota > 0) {
        const remaining = est.quota - (est.usage || 0);
        if (remaining < MIN_FREE_DISK_BYTES) {
          return {
            status: 'unavailable',
            simulated: false,
            reason: 'low_disk',
            hasWebGPU
          };
        }
      }
    }
  } catch (_) {}

  return {
    status: 'downloadable',
    simulated: false,
    reason: 'needs_download',
    hasWebGPU
  };
}

export async function downloadGemmaModel(onProgress = null) {
  const existing = await getCachedGemmaModel();
  if (existing) {
    if (onProgress) {
      onProgress({ loaded: existing.size, total: existing.size, pct: 100 });
    }
    return existing;
  }

  if (onProgress) {
    downloadProgressListeners.add(onProgress);
  }

  if (!activeDownloadPromise) {
    const mm = getModelManager();
    activeDownloadPromise = mm
      .downloadModel(GEMMA_MODEL_URL, {
        progressCallback: ({ loaded, total }) => {
          const effectiveTotal = total && total > 0 ? total : GEMMA_EXPECTED_BYTES;
          const pct = Math.min(
            100,
            Math.max(0, Math.round((loaded / effectiveTotal) * 100))
          );
          for (const listener of downloadProgressListeners) {
            try {
              listener({ loaded, total: effectiveTotal, pct });
            } catch (_) {}
          }
        }
      })
      .finally(() => {
        activeDownloadPromise = null;
      });
  }

  try {
    return await activeDownloadPromise;
  } finally {
    if (onProgress) {
      downloadProgressListeners.delete(onProgress);
    }
  }
}

export async function unloadGemmaRuntime() {
  if (idleUnloadTimer) {
    clearTimeout(idleUnloadTimer);
    idleUnloadTimer = null;
  }
  if (warmRuntime && warmRuntime.wllama) {
    const inst = warmRuntime.wllama;
    warmRuntime = null;
    try {
      await inst.exit();
    } catch (_) {}
  }
}

function scheduleIdleUnload() {
  if (idleUnloadTimer) {
    clearTimeout(idleUnloadTimer);
  }
  idleUnloadTimer = setTimeout(() => {
    unloadGemmaRuntime();
  }, IDLE_UNLOAD_MS);
}

export async function clearCachedGemmaModel() {
  await unloadGemmaRuntime();
  const mm = getModelManager();
  await mm.cacheManager.clear();
}

function computeOptimalThreads() {
  const hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  if (hw <= 2) return 2;
  if (hw <= 8) return Math.max(2, hw - 1);
  return Math.min(16, Math.floor(hw * 0.75));
}

function pickTargetContextSize(estimatedPromptTokens) {
  const needed = Math.max(8192, (estimatedPromptTokens || 0) + 2500);
  if (needed <= 32768) return 32768;
  if (needed <= 65536) return 65536;
  return MAX_MODEL_CTX;
}

async function ensureLoadedRuntime(modelObj, hasWebGPU, requiredCtx, onLoadTick = null) {
  const desiredCtx = Math.max(32768, requiredCtx || 32768);
  if (warmRuntime && warmRuntime.wllama && warmRuntime.nCtx >= desiredCtx) {
    scheduleIdleUnload();
    return warmRuntime;
  }

  await unloadGemmaRuntime();

  let ticker = null;
  if (onLoadTick) {
    let step = 0;
    ticker = setInterval(() => {
      step += 1;
      onLoadTick(step);
    }, 1100);
  }

  const threads = computeOptimalThreads();
  const buildLoadOpts = (useGpu, ctxSize) => ({
    n_gpu_layers: useGpu ? 99999 : 0,
    n_ctx: ctxSize,
    n_batch: 2048,
    n_ubatch: useGpu ? 512 : 256,
    n_parallel: 1,
    n_threads: threads,
    reasoning: false,
    default_template_kwargs: { enable_thinking: false }
  });

  try {
    const wllama = new Wllama(
      { default: WASM_URL },
      { suppressNativeLog: true }
    );

    try {
      await wllama.loadModel(modelObj, buildLoadOpts(hasWebGPU, desiredCtx));
      warmRuntime = { wllama, hasWebGPU, nCtx: desiredCtx };
      scheduleIdleUnload();
      return warmRuntime;
    } catch (loadErr) {
      try {
        await wllama.exit();
      } catch (_) {}
      if (hasWebGPU) {
        const cpuWllama = new Wllama(
          { default: WASM_URL },
          { suppressNativeLog: true }
        );
        await cpuWllama.loadModel(modelObj, buildLoadOpts(false, desiredCtx));
        warmRuntime = { wllama: cpuWllama, hasWebGPU: false, nCtx: desiredCtx };
        scheduleIdleUnload();
        return warmRuntime;
      }
      throw loadErr;
    }
  } finally {
    if (ticker) clearInterval(ticker);
  }
}

export function compactTranscriptLines(rawLines) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) return '';

  const VTT_CUE_ID_RE = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/[\w-]+)?|[\w-]{12,}\/\d+(?:-\d+)?)$/i;
  const VTT_TIMING_RE = /^(\d{1,2}:\d{2}(?::\d{2})?)(?:[.,]\d+)?\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?:\s+.*)?$/;
  const STANDALONE_TIME_RE = /^\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?$/i;
  const TEAMS_HEADER_RE = /^([A-Za-z][A-Za-z0-9 .,'()_-]{1,55}?)\s{2,}(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)$/i;
  const BRACKET_SPEAKER_RE = /^\[([^\]]+)\]:\s*(.*)$/;
  const VTT_VOICE_OPEN_RE = /^<v\s+([^>]+)>([\s\S]*)$/i;

  let firstTimestamp = '';
  let activeVttSpeaker = null;
  let pendingTeamsSpeaker = null;

  const blocks = []; // { speaker: string | null, parts: string[], charLen: number }

  const pushUtterance = (speaker, rawText) => {
    const text = String(rawText || '')
      .replace(/<\/v>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return;

    const cleanSpeaker = speaker ? String(speaker).replace(/\s+/g, ' ').trim() : null;
    const prev = blocks.length > 0 ? blocks[blocks.length - 1] : null;

    if (prev && prev.speaker === cleanSpeaker) {
      const lastPart = prev.parts[prev.parts.length - 1];
      if (lastPart === text) {
        return; // exact duplicate line
      }
      if (cleanSpeaker && lastPart && text.startsWith(lastPart) && text.length - lastPart.length < 160) {
        prev.charLen += text.length - lastPart.length;
        prev.parts[prev.parts.length - 1] = text;
        return; // progressive live-caption superset
      }
      if (cleanSpeaker && prev.charLen + text.length < 1200) {
        prev.parts.push(text);
        prev.charLen += text.length + 1;
        return;
      }
    }

    blocks.push({
      speaker: cleanSpeaker,
      parts: [text],
      charLen: text.length
    });
  };

  for (const item of rawLines) {
    const line = String(item || '').trim();
    if (!line) continue;
    if (/^(?:WEBVTT(?:\s|$)|NOTE(?:\s|$)|STYLE(?:\s|$))/i.test(line)) {
      activeVttSpeaker = null;
      continue;
    }

    const timingMatch = line.match(VTT_TIMING_RE);
    if (timingMatch) {
      if (!firstTimestamp) firstTimestamp = timingMatch[1];
      activeVttSpeaker = null;
      continue;
    }

    if (VTT_CUE_ID_RE.test(line)) {
      continue;
    }

    if (STANDALONE_TIME_RE.test(line)) {
      if (!firstTimestamp) firstTimestamp = line;
      continue;
    }

    const teamsHeaderMatch = line.match(TEAMS_HEADER_RE);
    if (teamsHeaderMatch) {
      pendingTeamsSpeaker = teamsHeaderMatch[1].trim();
      if (!firstTimestamp) firstTimestamp = teamsHeaderMatch[2].trim();
      continue;
    }

    const vttVoiceMatch = line.match(VTT_VOICE_OPEN_RE);
    if (vttVoiceMatch) {
      const speaker = vttVoiceMatch[1].trim();
      const body = vttVoiceMatch[2];
      const closed = /<\/v>/i.test(body);
      activeVttSpeaker = closed ? null : speaker;
      pendingTeamsSpeaker = null;
      pushUtterance(speaker, body);
      continue;
    }

    if (activeVttSpeaker) {
      const speaker = activeVttSpeaker;
      if (/<\/v>/i.test(line)) {
        activeVttSpeaker = null;
      }
      pushUtterance(speaker, line);
      continue;
    }

    const bracketMatch = line.match(BRACKET_SPEAKER_RE);
    if (bracketMatch) {
      pendingTeamsSpeaker = null;
      pushUtterance(bracketMatch[1], bracketMatch[2]);
      continue;
    }

    if (pendingTeamsSpeaker) {
      const speaker = pendingTeamsSpeaker;
      pendingTeamsSpeaker = null;
      pushUtterance(speaker, line);
      continue;
    }

    pushUtterance(null, line);
  }

  const formattedLines = [];
  if (firstTimestamp) {
    formattedLines.push(`[Transcript start time: ${firstTimestamp}]`);
  }
  for (const b of blocks) {
    const combined = b.parts.join(' ');
    formattedLines.push(b.speaker ? `[${b.speaker}]: ${combined}` : combined);
  }

  let joined = formattedLines.join('\n');
  if (joined.length > MAX_SINGLE_PASS_CHARS) {
    joined = joined.slice(0, MAX_SINGLE_PASS_CHARS) + '\n[Transcript truncated at 128K token limit]';
  }
  return joined;
}

function stripThinkingArtifacts(text) {
  if (!text) return '';
  return String(text)
    .replace(/<\|thought\|>[\s\S]*?<\|\/thought\|>\s*/g, '')
    .replace(/<\|channel>thought[\s\S]*?<channel\|>\s*/g, '')
    .replace(/^<\|thought\|>[\s\S]*$/g, '')
    .trim();
}

async function runChatCompletionStreaming(wllama, userPrompt, maxTokens, onPromptProgress, onTokenProgress) {
  const stream = await wllama.createChatCompletion({
    messages: [
      { role: 'system', content: GEMMA_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: maxTokens,
    temperature: 0.2,
    top_p: 0.9,
    return_progress: true,
    chat_template_kwargs: { enable_thinking: false },
    stream: true
  });

  let accumulated = '';
  let tokenCount = 0;
  for await (const chunk of stream) {
    const pp = chunk && chunk.prompt_progress;
    if (pp && typeof pp.total === 'number' && pp.total > 0 && tokenCount === 0) {
      const done = Math.min(pp.total, (pp.cache || 0) + (pp.processed || 0));
      if (onPromptProgress) {
        onPromptProgress(done, pp.total);
      }
    }

    const delta = chunk?.choices?.[0]?.delta?.content || '';
    if (!delta) continue;
    tokenCount += 1;
    accumulated += delta;
    if (onTokenProgress) {
      onTokenProgress(accumulated, tokenCount);
    }
  }
  return stripThinkingArtifacts(accumulated);
}

function buildMinutesPrompt(sourceText, dateFormatted) {
  return `Generate concise Markdown meeting minutes for a meeting on ${dateFormatted} using these exact top-level bullet headings (do not output a # Title section):
*   **Date, time, and attendees:**
    *   [Date], at [Time from transcript]
    *   Attendees: [Name] ([Company if clear from transcript, else omit company])
*   **Meeting purpose:** Brief goal of the meeting.
*   **Agenda items:** Key agenda sections.
*   **Key discussions:** Concise summary of main points discussed.
*   **Decisions made:** State decisions clearly in **bold**.
*   **Action items:** Owner, action, and deadline if stated.
*   **Follow-ups:** Unresolved or deferred topics.

Transcript:
${sourceText}`;
}

async function runSimulatedSummary(lines, dateFormatted, onProgress) {
  for (const dlPct of [0, 18, 41, 67, 89, 100]) {
    onProgress(
      6 + Math.round(dlPct * 0.26),
      `Downloading Gemma 4 E2B (${dlPct}%)...`
    );
    await new Promise((r) => setTimeout(r, 350));
  }
  for (const [pct, label] of [
    [36, 'Loading Gemma 4 E2B...'],
    [54, 'Reading transcript on-device...'],
    [78, 'Drafting meeting notes...']
  ]) {
    onProgress(pct, label);
    await new Promise((r) => setTimeout(r, 400));
  }
  const preview = lines
    .slice(0, 5)
    .map((l) => `    *   ${String(l).substring(0, 140)}`)
    .join('\n');
  return `*   **Date, time, and attendees:**\n    *   ${dateFormatted}\n    *   Attendees: Meeting Participants\n*   **Meeting purpose:** Simulated DEV Gemma 4 E2B summary.\n*   **Agenda items:**\n    *   Transcript review (${lines.length} lines)\n*   **Key discussions:**\n${preview || '    *   Discussion captured.'}\n*   **Decisions made:**\n    *   **Verified simulated Gemma 4 E2B pipeline.**\n*   **Action items:**\n    *   Review generated Markdown file.\n*   **Follow-ups:**\n    *   Switch DEV Simulate to Real for local Gemma 4 E2B inference.`;
}

function enqueueInference(fn) {
  const run = inferenceQueue.then(fn, fn);
  inferenceQueue = run.catch(() => {});
  return run;
}

export function generateNotesWithGemma(lines, dateFormatted, simMode = 'real', onProgress = () => {}) {
  return enqueueInference(async () => {
    if (simMode === 'low_disk') {
      const err = new Error('At least 3 GB of free disk space is required for Gemma On-Device.');
      err.code = 'NANO_UNAVAILABLE';
      err.reason = 'low_disk';
      throw err;
    }

    if (simMode === 'downloadable') {
      const cachedForSim = await getCachedGemmaModel();
      if (!cachedForSim) {
        return await runSimulatedSummary(lines, dateFormatted, onProgress);
      }
      for (const dlPct of [0, 22, 48, 76, 100]) {
        onProgress(
          6 + Math.round(dlPct * 0.24),
          `Downloading Gemma 4 E2B (${dlPct}%)...`
        );
        await new Promise((r) => setTimeout(r, 280));
      }
    }

    const avail = await checkGemmaAvailability('real');
    if (avail.status === 'unavailable') {
      const err = new Error('At least 3 GB of free disk space is required for Gemma On-Device.');
      err.code = 'NANO_UNAVAILABLE';
      err.reason = avail.reason || 'low_disk';
      throw err;
    }

    const compactedTranscript = compactTranscriptLines(lines);
    if (!compactedTranscript) {
      throw new Error('The transcript contains no readable speech lines.');
    }

    const prompt = buildMinutesPrompt(compactedTranscript, dateFormatted);
    const estimatedPromptTokens = Math.ceil(prompt.length / 3.2);
    const targetCtx = pickTargetContextSize(estimatedPromptTokens);

    let modelObj = await getCachedGemmaModel();
    let loadStartPct = 12;
    if (!modelObj) {
      onProgress(6, 'Downloading Gemma 4 E2B (0%)...');
      modelObj = await downloadGemmaModel(({ loaded, total, pct }) => {
        const mappedPct = 6 + Math.round(pct * 0.24);
        onProgress(
          mappedPct,
          `Downloading Gemma 4 E2B — ${formatBytesGB(loaded)} / ${formatBytesGB(total)} (${pct}%)`
        );
      });
      loadStartPct = 30;
    }

    const accelLabel = avail.hasWebGPU ? 'WebGPU' : 'CPU';
    onProgress(loadStartPct, `Loading Gemma 4 E2B (${accelLabel})...`);

    const runtime = await ensureLoadedRuntime(
      modelObj,
      avail.hasWebGPU,
      targetCtx,
      (tickStep) => {
        const tickPct = Math.min(35, loadStartPct + tickStep);
        onProgress(tickPct, `Loading Gemma 4 E2B (${accelLabel})...`);
      }
    );
    scheduleIdleUnload();

    onProgress(36, 'Reading transcript on-device...');
    const minutes = await runChatCompletionStreaming(
      runtime.wllama,
      prompt,
      1500,
      (doneTokens, totalTokens) => {
        const ratio = Math.min(1, doneTokens / Math.max(1, totalTokens));
        const pct = 36 + Math.round(ratio * 38); // 36% -> 74% smoothly across prompt prefill
        onProgress(
          pct,
          `Reading transcript (${doneTokens.toLocaleString()} / ${totalTokens.toLocaleString()} tokens)...`
        );
      },
      (partial, tokenCount) => {
        const ratio = Math.min(1, partial.length / 1600);
        const pct = 75 + Math.round(ratio * 20); // 75% -> 95% smoothly across note drafting
        onProgress(
          pct,
          `Drafting meeting notes (${tokenCount} tokens)...`
        );
      }
    );

    scheduleIdleUnload();
    if (!minutes) {
      throw new Error('Empty response from Gemma 4 E2B.');
    }
    return minutes;
  });
}
