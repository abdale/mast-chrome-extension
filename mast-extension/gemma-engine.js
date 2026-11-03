// On-Device Gemma 4 E2B-IT Engine (Single-Pass, WebGPU + Multi-Threaded WASM64 SIMD CPU)
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
const MAX_WEBGPU_TRANSCRIPT_CHARS = 64000; // ~16K clean tokens (fast single-pass on WebGPU)
const MAX_CPU_TRANSCRIPT_CHARS = 8500; // ~2.1K high-salience tokens (~1.5-3 min single-pass on CPU)

const GEMMA_SYSTEM_PROMPT =
  'You are an expert meeting minutes generator. Produce clear, accurate, concise Markdown meeting notes strictly grounded in the provided transcript. Never invent facts, attendees, or action items.';

const WLLAMA_QUIET_ERROR_LOGGER = {
  debug: () => {},
  log: () => {},
  warn: () => {},
  error: (...args) => console.error('[mast-gemma]', ...args)
};

const FILLER_EXACT_SET = new Set([
  'yeah', 'yep', 'yes', 'yup', 'no', 'nope', 'ok', 'okay', 'k', 'sure', 'right',
  'alright', 'all right', 'mm hmm', 'mhm', 'mmhmm', 'uh huh', 'uhhuh', 'hmm', 'hm',
  'uh', 'um', 'ah', 'oh', 'got it', 'gotcha', 'makes sense', 'sounds good',
  'perfect', 'great', 'awesome', 'cool', 'nice', 'exactly', 'totally', 'absolutely',
  'agreed', 'true', 'fair enough', 'thank you', 'thanks', 'thanks everyone',
  'thank you everyone', 'bye', 'bye everyone', 'see ya', 'take care', 'hello',
  'hi', 'hey', 'hi everyone', 'hey everyone', 'good morning', 'good afternoon'
]);

const AV_CHECK_RE =
  /^(?:can (?:you|everyone|everybody) (?:hear me|see my screen|see this)|sorry[,]? i was on mute|you(?:'re| are) on mute|let me share my screen|sharing my screen now)[.?!]*$/i;

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
  if (hw <= 20) return Math.floor(hw * 0.75);
  return Math.min(32, Math.max(15, Math.floor(hw * 0.5)));
}

function pickTargetContextSize(estimatedPromptTokens, hasWebGPU) {
  const needed = Math.max(4096, (estimatedPromptTokens || 0) + 1800);
  if (!hasWebGPU) {
    if (needed <= 4096) return 4096;
    if (needed <= 8192) return 8192;
    if (needed <= 16384) return 16384;
    return 32768;
  }
  if (needed <= 8192) return 8192;
  if (needed <= 16384) return 16384;
  if (needed <= 32768) return 32768;
  if (needed <= 65536) return 65536;
  return MAX_MODEL_CTX;
}

async function ensureLoadedRuntime(modelObj, hasWebGPU, requiredCtx, onLoadTick = null) {
  const minDefaultCtx = hasWebGPU ? 16384 : 8192;
  const desiredCtx = Math.max(minDefaultCtx, requiredCtx || minDefaultCtx);
  if (
    warmRuntime &&
    warmRuntime.wllama &&
    warmRuntime.hasWebGPU === !!hasWebGPU &&
    warmRuntime.nCtx >= desiredCtx
  ) {
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
    // Small n_batch on CPU emits prompt_progress every 128 tokens (~4-10s) and improves cache locality
    n_batch: useGpu ? 512 : 128,
    n_ubatch: useGpu ? 512 : 128,
    n_parallel: 1,
    n_threads: threads,
    n_ctx_checkpoints: 0,
    cache_idle_slots: false,
    reasoning: false,
    default_template_kwargs: { enable_thinking: false }
  });

  try {
    const wllama = new Wllama(
      { default: WASM_URL },
      { suppressNativeLog: false, logger: WLLAMA_QUIET_ERROR_LOGGER }
    );

    try {
      await wllama.loadModel(modelObj, buildLoadOpts(hasWebGPU, desiredCtx));
      warmRuntime = { wllama, hasWebGPU: !!hasWebGPU, nCtx: desiredCtx };
      scheduleIdleUnload();
      return warmRuntime;
    } catch (loadErr) {
      try {
        await wllama.exit();
      } catch (_) {}
      if (hasWebGPU) {
        const cpuCtx = Math.min(desiredCtx, 16384);
        const cpuWllama = new Wllama(
          { default: WASM_URL },
          { suppressNativeLog: false, logger: WLLAMA_QUIET_ERROR_LOGGER }
        );
        await cpuWllama.loadModel(modelObj, buildLoadOpts(false, cpuCtx));
        warmRuntime = { wllama: cpuWllama, hasWebGPU: false, nCtx: cpuCtx };
        scheduleIdleUnload();
        return warmRuntime;
      }
      throw loadErr;
    }
  } finally {
    if (ticker) clearInterval(ticker);
  }
}

function normalizeForMatch(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(?:uh+|um+|er+|ah+|like|you know|i mean)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanStutters(text) {
  return String(text || '')
    .replace(/\b(uh+|um+)\b[,\s]*/gi, '')
    .replace(/\b(\w+)(?:\s*,\s*|\s+)\1\b/gi, '$1')
    .replace(/\b(\w+\s+\w+)(?:\s*,\s*|\s+)\1\b/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function isProgressiveSuperset(olderNorm, newerNorm) {
  if (!olderNorm || !newerNorm) return false;
  if (olderNorm === newerNorm) return true;
  if (newerNorm.length <= olderNorm.length) return false;
  if (newerNorm.startsWith(olderNorm) && newerNorm.length - olderNorm.length < 300) {
    return true;
  }
  const oldWords = olderNorm.split(' ');
  const newWords = newerNorm.split(' ');
  if (
    oldWords.length >= 3 &&
    newWords.length >= oldWords.length + 2 &&
    newWords.length - oldWords.length <= 45
  ) {
    for (let i = 0; i < oldWords.length - 1; i++) {
      if (oldWords[i] !== newWords[i]) return false;
    }
    return true;
  }
  return false;
}

function scoreUtteranceSalience(text) {
  const lower = text.toLowerCase();
  let score = 1.0;

  if (
    /\b(decid\w*|decision\w*|agreed|approve\w*|confirm\w*|finaliz\w*|sign[- ]?off|consensus|conclud\w*|go ahead with|moving forward with|selected|chosen)\b/.test(
      lower
    )
  ) {
    score += 10;
  }
  if (
    /\b(action item\w*|next step\w*|todo|to-do|follow[- ]?up\w*|i will|i'll|we will|we'll|will send|will share|will schedule|will update|will create|will review|take an action|assign\w*|owner|responsible|deliverable\w*)\b/.test(
      lower
    )
  ) {
    score += 9;
  }
  if (
    /\b(monday|tuesday|wednesday|thursday|friday|next week|this week|tomorrow|eod|end of day|end of week|q[1-4]|january|february|march|april|may|june|july|august|september|october|november|december|deadline|target date|eta|milestone\w*|by the \d+)\b/.test(
      lower
    )
  ) {
    score += 6;
  }
  if (
    /\b(agenda|purpose|goal|objective|blocker\w*|blocked|risk\w*|issue\w*|concern\w*|defer\w*|parking lot|open question\w*|escalat\w*|dependency|dependencies|requirement\w*|architecture|security|budget|cost|timeline|launch|migration|production)\b/.test(
      lower
    )
  ) {
    score += 4;
  }
  if (
    /(?:\$\d|\b\d+(?:\.\d+)?%|\b\d+\s*(?:gb|tb|ms|days|weeks|months|users|nodes|clusters|million|k)\b|\bv\d+\.\d+)/i.test(
      text
    )
  ) {
    score += 4;
  }
  if (text.includes('?') && text.length > 35) {
    score += 2.5;
  }
  const wordCount = text.split(/\s+/).length;
  if (wordCount < 5) score -= 1.5;
  else score += Math.min(3, wordCount / 18);

  return score;
}

export function compactTranscriptLines(rawLines, options = {}) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) return '';

  const maxChars =
    typeof options.maxChars === 'number' && options.maxChars > 0
      ? options.maxChars
      : MAX_WEBGPU_TRANSCRIPT_CHARS;

  const VTT_CUE_ID_RE =
    /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/[\w-]+)?|[\w-]{12,}\/\d+(?:-\d+)?)$/i;
  const VTT_TIMING_RE =
    /^(\d{1,2}:\d{2}(?::\d{2})?)(?:[.,]\d+)?\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?:\s+.*)?$/;
  const STANDALONE_TIME_RE = /^\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?$/i;
  const TEAMS_HEADER_RE =
    /^([A-Za-z][A-Za-z0-9 .,'()_-]{1,65}?)\s{2,}(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)$/i;
  const BRACKET_SPEAKER_RE = /^\[([^\]]+)\]:\s*(.*)$/;
  const VTT_VOICE_OPEN_RE = /^<v\s+([^>]+)>([\s\S]*)$/i;

  let firstTimestamp = '';
  let activeVttSpeaker = null;
  let pendingTeamsSpeaker = null;

  const participantSet = new Set();
  const utterances = []; // { speaker: string | null, text: string, norm: string }
  const seenLongNorms = new Set(); // deduplicates virtualized scroll re-mounts
  const recentShortNorms = [];

  const pushUtterance = (rawSpeaker, rawText) => {
    const text = cleanStutters(
      String(rawText || '')
        .replace(/<\/v>/gi, '')
        .replace(/<[^>]+>/g, ' ')
    );
    if (!text) return;

    let cleanSpeaker = rawSpeaker ? String(rawSpeaker).replace(/\s+/g, ' ').trim() : null;
    if (cleanSpeaker && /^unknown$/i.test(cleanSpeaker)) {
      cleanSpeaker = null;
    }
    if (cleanSpeaker) {
      participantSet.add(cleanSpeaker);
    }

    const norm = normalizeForMatch(text);
    if (!norm) return;
    if (FILLER_EXACT_SET.has(norm) || AV_CHECK_RE.test(text)) {
      return;
    }

    const lookbackStart = Math.max(0, utterances.length - 4);
    for (let idx = utterances.length - 1; idx >= lookbackStart; idx--) {
      const prev = utterances[idx];
      const compatibleSpeaker =
        !cleanSpeaker || !prev.speaker || prev.speaker === cleanSpeaker;
      if (!compatibleSpeaker) continue;

      if (prev.norm === norm) {
        if (!prev.speaker && cleanSpeaker) prev.speaker = cleanSpeaker;
        return;
      }
      if (isProgressiveSuperset(prev.norm, norm)) {
        if (prev.norm.length >= 32) seenLongNorms.delete(prev.norm);
        prev.text = text;
        prev.norm = norm;
        if (!prev.speaker && cleanSpeaker) prev.speaker = cleanSpeaker;
        if (norm.length >= 32) seenLongNorms.add(norm);
        return;
      }
      if (isProgressiveSuperset(norm, prev.norm)) {
        return;
      }
    }

    if (norm.length >= 32) {
      if (seenLongNorms.has(norm)) return;
      seenLongNorms.add(norm);
    } else {
      if (recentShortNorms.includes(norm)) return;
      recentShortNorms.push(norm);
      if (recentShortNorms.length > 30) recentShortNorms.shift();
    }

    utterances.push({ speaker: cleanSpeaker, text, norm });
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

  if (utterances.length === 0) return '';

  const headerLines = [];
  if (firstTimestamp) {
    headerLines.push(`[Transcript start time: ${firstTimestamp}]`);
  }
  const participants = Array.from(participantSet);
  if (participants.length > 0) {
    headerLines.push(`[Participants: ${participants.join(', ')}]`);
  }
  const headerStr = headerLines.length > 0 ? headerLines.join('\n') + '\n' : '';

  const formatConsolidated = (uttList) => {
    const blocks = [];
    for (const u of uttList) {
      const prev = blocks.length > 0 ? blocks[blocks.length - 1] : null;
      if (prev && prev.speaker === u.speaker && prev.charLen + u.text.length < 900) {
        prev.parts.push(u.text);
        prev.charLen += u.text.length + 1;
      } else {
        blocks.push({ speaker: u.speaker, parts: [u.text], charLen: u.text.length });
      }
    }
    return (
      headerStr +
      blocks
        .map((b) => (b.speaker ? `[${b.speaker}]: ${b.parts.join(' ')}` : b.parts.join(' ')))
        .join('\n')
    );
  };

  const fullCleaned = formatConsolidated(utterances);
  if (fullCleaned.length <= maxChars) {
    return fullCleaned;
  }

  // Salience-preserving chronological condensation when cleaned transcript exceeds hardware budget
  const bodyBudget = Math.max(2000, maxChars - headerStr.length - 80);
  const scored = utterances.map((u, idx) => ({
    ...u,
    idx,
    cost: u.text.length + (u.speaker ? u.speaker.length + 5 : 1),
    score: scoreUtteranceSalience(u.text)
  }));

  const selectedIdx = new Set();
  let usedChars = 0;

  const trySelect = (item) => {
    if (selectedIdx.has(item.idx)) return false;
    if (usedChars + item.cost > bodyBudget) return false;
    selectedIdx.add(item.idx);
    usedChars += item.cost;
    return true;
  };

  // 1. Preserve each participant's top turn
  const bestBySpeaker = new Map();
  for (const item of scored) {
    if (!item.speaker) continue;
    const cur = bestBySpeaker.get(item.speaker);
    if (!cur || item.score > cur.score) bestBySpeaker.set(item.speaker, item);
  }
  for (const item of bestBySpeaker.values()) {
    if (item.cost <= bodyBudget * 0.15) trySelect(item);
  }

  // 2. Cover 12 equal chronological segments across the full meeting duration
  const numBuckets = Math.min(12, scored.length);
  const bucketBudget = Math.floor(((bodyBudget - usedChars) * 0.55) / numBuckets);
  for (let b = 0; b < numBuckets; b++) {
    const start = Math.floor((b * scored.length) / numBuckets);
    const end = Math.floor(((b + 1) * scored.length) / numBuckets);
    const slice = scored.slice(start, end).sort((a, c) => c.score - a.score);
    let bUsed = 0;
    for (const item of slice) {
      if (bUsed + item.cost > bucketBudget && bUsed > 0) continue;
      if (trySelect(item)) {
        bUsed += item.cost;
        if (bUsed >= bucketBudget) break;
      }
    }
  }

  // 3. Fill remaining budget with highest-salience decisions, action items, deadlines, and metrics
  const remainingByScore = [...scored].sort((a, c) => c.score - a.score);
  for (const item of remainingByScore) {
    if (usedChars >= bodyBudget * 0.96) break;
    trySelect(item);
  }

  const chosenChronological = utterances.filter((_, idx) => selectedIdx.has(idx));
  let condensed = formatConsolidated(chosenChronological);
  if (condensed.length > maxChars) {
    condensed = condensed.slice(0, maxChars);
  }
  return condensed;
}

function stripThinkingArtifacts(text) {
  if (!text) return '';
  return String(text)
    .replace(/<\|thought\|>[\s\S]*?<\|\/thought\|>\s*/g, '')
    .replace(/<\|channel>thought[\s\S]*?<channel\|>\s*/g, '')
    .replace(/^<\|thought\|>[\s\S]*$/g, '')
    .trim();
}

async function runChatCompletionStreaming(
  wllama,
  userPrompt,
  maxTokens,
  onPromptProgress,
  onTokenProgress
) {
  const stream = await wllama.createChatCompletion({
    messages: [
      { role: 'system', content: GEMMA_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: maxTokens,
    temperature: 0.2,
    top_p: 0.9,
    cache_prompt: false,
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

export function generateNotesWithGemma(
  lines,
  dateFormatted,
  simMode = 'real',
  onProgress = () => {}
) {
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

    const maxTranscriptChars = avail.hasWebGPU
      ? MAX_WEBGPU_TRANSCRIPT_CHARS
      : MAX_CPU_TRANSCRIPT_CHARS;
    const compactedTranscript = compactTranscriptLines(lines, {
      maxChars: maxTranscriptChars
    });
    if (!compactedTranscript) {
      throw new Error('The transcript contains no readable speech lines.');
    }

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

    const prompt = buildMinutesPrompt(compactedTranscript, dateFormatted);
    const estimatedPromptTokens = Math.ceil(prompt.length / 3.2);
    const targetCtx = pickTargetContextSize(estimatedPromptTokens, avail.hasWebGPU);

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

    // If WebGPU failed to initialize and fell back to CPU, re-apply CPU transcript budget
    let effectivePrompt = prompt;
    if (avail.hasWebGPU && !runtime.hasWebGPU && compactedTranscript.length > MAX_CPU_TRANSCRIPT_CHARS) {
      const cpuTranscript = compactTranscriptLines(lines, {
        maxChars: MAX_CPU_TRANSCRIPT_CHARS
      });
      effectivePrompt = buildMinutesPrompt(cpuTranscript, dateFormatted);
    }

    scheduleIdleUnload();

    const maxOutputTokens = runtime.hasWebGPU ? 1500 : 950;
    onProgress(36, 'Reading transcript on-device...');
    const minutes = await runChatCompletionStreaming(
      runtime.wllama,
      effectivePrompt,
      maxOutputTokens,
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
