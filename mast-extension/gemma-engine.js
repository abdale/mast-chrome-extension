// On-Device Gemma 4 E2B-IT Engine (WebGPU + Multi-Threaded WASM64 SIMD CPU Fallback)
import { Wllama, ModelManager } from './vendor/wllama/wllama.js';

export const GEMMA_MODEL_ID = 'gemma-4-e2b-it';
export const GEMMA_MODEL_LABEL = 'Gemma 4 E2B (On-Device)';
export const GEMMA_MODEL_URL =
  'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q3_K_S.gguf';
export const GEMMA_EXPECTED_BYTES = 2445652064; // ~2.28 GiB (2.45 GB)
export const MIN_FREE_DISK_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB

const WASM_URL = new URL('./vendor/wllama/wllama.wasm', import.meta.url).href;
const IDLE_UNLOAD_MS = 5 * 60 * 1000;

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
      onProgress({
        loaded: existing.size,
        total: existing.size,
        pct: 100
      });
    }
    return existing;
  }

  if (onProgress) {
    downloadProgressListeners.add(onProgress);
  }

  if (!activeDownloadPromise) {
    const mm = getModelManager();
    activeDownloadPromise = mm
      .getModelOrDownload(
        { url: GEMMA_MODEL_URL },
        {
          progressCallback: ({ loaded, total }) => {
            const effectiveTotal =
              total && total > 0 ? total : GEMMA_EXPECTED_BYTES;
            const safeLoaded = Math.max(0, Number(loaded) || 0);
            const pct = Math.min(
              100,
              Math.max(0, Math.round((safeLoaded / effectiveTotal) * 100))
            );
            for (const listener of downloadProgressListeners) {
              try {
                listener({
                  loaded: safeLoaded,
                  total: effectiveTotal,
                  pct
                });
              } catch (_) {}
            }
          }
        }
      )
      .finally(() => {
        activeDownloadPromise = null;
        downloadProgressListeners.clear();
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
  return 8;
}

async function ensureLoadedRuntime(modelObj, hasWebGPU) {
  const desiredCtx = hasWebGPU ? 16384 : 12288;
  if (warmRuntime && warmRuntime.wllama && warmRuntime.nCtx >= desiredCtx) {
    scheduleIdleUnload();
    return warmRuntime;
  }

  await unloadGemmaRuntime();

  const wllama = new Wllama(
    { default: WASM_URL },
    { suppressNativeLog: true }
  );

  try {
    await wllama.loadModel(modelObj, {
      n_gpu_layers: hasWebGPU ? 99999 : 0,
      n_ctx: desiredCtx,
      n_parallel: 1,
      n_threads: computeOptimalThreads(),
      default_template_kwargs: { enable_thinking: false }
    });
  } catch (loadErr) {
    try {
      await wllama.exit();
    } catch (_) {}
    if (hasWebGPU) {
      // Automatic fallback to SIMD CPU if WebGPU device creation or buffer limits fail
      const cpuWllama = new Wllama(
        { default: WASM_URL },
        { suppressNativeLog: true }
      );
      await cpuWllama.loadModel(modelObj, {
        n_gpu_layers: 0,
        n_ctx: 12288,
        n_parallel: 1,
        n_threads: computeOptimalThreads(),
        default_template_kwargs: { enable_thinking: false }
      });
      warmRuntime = { wllama: cpuWllama, hasWebGPU: false, nCtx: 12288 };
      scheduleIdleUnload();
      return warmRuntime;
    }
    throw loadErr;
  }

  warmRuntime = { wllama, hasWebGPU, nCtx: desiredCtx };
  scheduleIdleUnload();
  return warmRuntime;
}

function stripThinkingArtifacts(text) {
  if (!text) return '';
  return String(text)
    .replace(/<\|thought\|>[\s\S]*?<\|\/thought\|>\s*/g, '')
    .replace(/^<\|thought\|>[\s\S]*$/g, '')
    .trim();
}

async function runChatCompletionStreaming(wllama, userPrompt, maxTokens, onTokenProgress) {
  const stream = await wllama.createChatCompletion({
    messages: [
      { role: 'system', content: GEMMA_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: maxTokens,
    temperature: 0.2,
    top_p: 0.9,
    chat_template_kwargs: { enable_thinking: false },
    stream: true
  });

  let accumulated = '';
  let tokenCount = 0;
  for await (const chunk of stream) {
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

function buildMinutesPrompt(sourceText, dateFormatted, isFromChunkSummaries = false) {
  const sourceLabel = isFromChunkSummaries ? 'Segment Summaries' : 'Transcript';
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

${sourceLabel}:
${sourceText}`;
}

function splitTranscriptChunks(lines, maxCharsPerChunk = 20000) {
  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (const rawLine of lines) {
    const line = String(rawLine || '');
    if (line.length > maxCharsPerChunk) {
      if (current.length > 0) {
        chunks.push(current.join('\n'));
        current = [];
        currentLen = 0;
      }
      for (let i = 0; i < line.length; i += maxCharsPerChunk) {
        chunks.push(line.slice(i, i + maxCharsPerChunk));
      }
      continue;
    }
    if (currentLen + line.length + 1 > maxCharsPerChunk && current.length > 0) {
      chunks.push(current.join('\n'));
      current = [line];
      currentLen = line.length;
    } else {
      current.push(line);
      currentLen += line.length + 1;
    }
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}

async function runSimulatedSummary(lines, dateFormatted, onProgress) {
  for (const dlPct of [0, 18, 41, 67, 89, 100]) {
    onProgress(
      6 + Math.round(dlPct * 0.30),
      `Downloading Gemma 4 E2B (${dlPct}%)...`
    );
    await new Promise((r) => setTimeout(r, 380));
  }
  for (const [pct, label] of [
    [44, 'Loading Gemma 4 E2B...'],
    [64, 'Analyzing transcript on-device...'],
    [86, 'Drafting meeting notes...']
  ]) {
    onProgress(pct, label);
    await new Promise((r) => setTimeout(r, 420));
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
          6 + Math.round(dlPct * 0.30),
          `Downloading Gemma 4 E2B (${dlPct}%)...`
        );
        await new Promise((r) => setTimeout(r, 320));
      }
    }

    const avail = await checkGemmaAvailability('real');
    if (avail.status === 'unavailable') {
      const err = new Error('At least 3 GB of free disk space is required for Gemma On-Device.');
      err.code = 'NANO_UNAVAILABLE';
      err.reason = avail.reason || 'low_disk';
      throw err;
    }

    let modelObj = await getCachedGemmaModel();
    let loadStageStartPct = 14;
    if (!modelObj) {
      onProgress(6, 'Downloading Gemma 4 E2B (0%)...');
      modelObj = await downloadGemmaModel(({ loaded, total, pct }) => {
        const mappedPct = 6 + Math.round(pct * 0.30);
        onProgress(
          mappedPct,
          `Downloading Gemma 4 E2B — ${formatBytesGB(loaded)} / ${formatBytesGB(total)} (${pct}%)`
        );
      });
      loadStageStartPct = 38;
    }

    const accelLabel = avail.hasWebGPU ? 'WebGPU' : 'CPU';
    onProgress(loadStageStartPct, `Loading Gemma 4 E2B (${accelLabel})...`);
    const runtime = await ensureLoadedRuntime(modelObj, avail.hasWebGPU);
    scheduleIdleUnload();

    const fullTranscript = lines.join('\n');
    const singlePassCharLimit = runtime.hasWebGPU ? 42000 : 28000;

    if (fullTranscript.length <= singlePassCharLimit) {
      onProgress(46, `Analyzing transcript (${lines.length} lines)...`);
      const prompt = buildMinutesPrompt(fullTranscript, dateFormatted, false);
      const minutes = await runChatCompletionStreaming(
        runtime.wllama,
        prompt,
        1400,
        (partial, tokenCount) => {
          const ratio = Math.min(1, partial.length / 1600);
          onProgress(
            50 + Math.round(ratio * 44),
            `Drafting meeting notes (${tokenCount} tokens)...`
          );
        }
      );
      scheduleIdleUnload();
      if (!minutes) {
        throw new Error('Empty response from Gemma 4 E2B.');
      }
      return minutes;
    }

    // Map-reduce for ultra-long multi-hour transcripts
    const chunkSize = runtime.hasWebGPU ? 28000 : 20000;
    const chunks = splitTranscriptChunks(lines, chunkSize);
    const chunkSummaries = [];

    for (let i = 0; i < chunks.length; i++) {
      const startPct = 44 + Math.round((i / chunks.length) * 32);
      const endPct = 44 + Math.round(((i + 1) / chunks.length) * 32);
      onProgress(startPct, `Summarizing part ${i + 1} of ${chunks.length}...`);

      const chunkPrompt = `Extract concise factual bullet points from part ${i + 1} of ${chunks.length} of this meeting transcript. Include attendees, key points discussed, decisions made, action items (owner + deadline), and follow-ups.\n\nTranscript Part ${i + 1}:\n${chunks[i]}`;
      const partSummary = await runChatCompletionStreaming(
        runtime.wllama,
        chunkPrompt,
        650,
        (partial, tokenCount) => {
          const ratio = Math.min(1, partial.length / 800);
          onProgress(
            startPct + Math.round(ratio * (endPct - startPct)),
            `Summarizing part ${i + 1} of ${chunks.length} (${tokenCount} tokens)...`
          );
        }
      );
      chunkSummaries.push(`### Segment ${i + 1}\n${partSummary}`);
    }

    onProgress(78, 'Synthesizing final meeting notes...');
    const finalPrompt = buildMinutesPrompt(
      chunkSummaries.join('\n\n'),
      dateFormatted,
      true
    );
    const finalMinutes = await runChatCompletionStreaming(
      runtime.wllama,
      finalPrompt,
      1400,
      (partial, tokenCount) => {
        const ratio = Math.min(1, partial.length / 1600);
        onProgress(
          80 + Math.round(ratio * 15),
          `Drafting final meeting notes (${tokenCount} tokens)...`
        );
      }
    );
    scheduleIdleUnload();
    if (!finalMinutes) {
      throw new Error('Empty response from Gemma 4 E2B.');
    }
    return finalMinutes;
  });
}
