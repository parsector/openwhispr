const fs = require("fs");
const debugLogger = require("./debugLogger");
const speakerEmbeddings = require("./speakerEmbeddings");
const { MAX_EMBEDDING_SECONDS } = speakerEmbeddings;
const { downsample24kTo16k, pcm16ToFloat32 } = require("../utils/audioUtils");
const { MAX_SPEAKER_COUNT } = require("../constants/speakerDetection.json");
const { normalizeSpeakerIndexBase } = require("./speakerIndexBase");

function clampMaxSpeakers(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return MAX_SPEAKER_COUNT;
  return Math.max(1, Math.min(MAX_SPEAKER_COUNT, Math.floor(n)));
}

// onnxruntime-node ships no darwin/x64 prebuilt binding since 1.24, so the
// require throws on Intel Macs (#1500). A missing binding must degrade live
// speaker identification, never fail the meeting start that triggers it.
let ortLoadFailed = false;

function loadOnnxRuntime() {
  if (ortLoadFailed) return null;
  try {
    return require("onnxruntime-node");
  } catch (error) {
    ortLoadFailed = true;
    debugLogger.warn(
      "onnxruntime-node binding failed to load — live speaker identification disabled",
      { error: error.message, platform: process.platform, arch: process.arch }
    );
    return null;
  }
}

const SAMPLE_RATE = 16000;
const VAD_WINDOW_SIZE = 512;
const MIN_SEGMENT_SECONDS = 1.5;
const MIN_SEGMENT_SAMPLES = Math.round(SAMPLE_RATE * MIN_SEGMENT_SECONDS);
const LIVE_IDENTIFICATION_MIN_SECONDS = 1.6;
const LIVE_IDENTIFICATION_MIN_SAMPLES = Math.round(SAMPLE_RATE * LIVE_IDENTIFICATION_MIN_SECONDS);
const LIVE_IDENTIFICATION_INTERVAL_SECONDS = 1.0;
const LIVE_IDENTIFICATION_INTERVAL_SAMPLES = Math.round(
  SAMPLE_RATE * LIVE_IDENTIFICATION_INTERVAL_SECONDS
);
const MAX_EMBEDDING_SAMPLES = SAMPLE_RATE * MAX_EMBEDDING_SECONDS;
const SPEECH_CHUNKS_MAX_SAMPLES = MAX_EMBEDDING_SAMPLES * 4;
const SPEECH_THRESHOLD = 0.15;
const SILENCE_THRESHOLD = 0.08;
const SILENCE_WINDOWS_TO_END = 24;
const MATCH_THRESHOLD = 0.65;
const MATCH_MARGIN = 0.03;
const ANCHOR_THRESHOLD = 0.60;
const ANCHOR_MARGIN = 0.08;
const ANCHOR_MIN_VOICED_SAMPLES = SAMPLE_RATE * 3;
const ANCHOR_MIN_CONSISTENCY = 0.80;
const RECLUSTER_SIMILARITY = 0.93;
const RECLUSTER_MARGIN = 0.08;
const LIVE_WINDOW_PADDING_SECONDS = 0.75;
// The 24 kHz -> 16 kHz resampler restarts on every buffer and only divides
// evenly on whole groups of 3 input samples (6 bytes). Capture buffers come in
// arbitrary sizes (PipeWire quantum, coalesced pipe reads, renderer loopback
// frames, recovery silence), so a partial group is carried into the next
// buffer; dropping it pulls the identifier clock behind real time.
const RESAMPLE_GROUP_BYTES = 6;
const DEFAULT_VAD_STATE_SHAPE = [2, 1, 64];
// The VAD graph is tiny (~64 ops per 512-sample window at ~31 Hz); ORT's
// default thread pool spins one worker per core for no throughput gain.
const VAD_SESSION_OPTIONS = {
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
  executionMode: "sequential",
};

function appendFloat32(existing, next) {
  if (!existing.length) return next;
  if (!next.length) return existing;

  const merged = new Float32Array(existing.length + next.length);
  merged.set(existing, 0);
  merged.set(next, existing.length);
  return merged;
}

function totalSampleCount(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  return total;
}

function concatFloat32Arrays(chunks) {
  if (chunks.length === 0) return new Float32Array(0);
  if (chunks.length === 1) return chunks[0];

  const merged = new Float32Array(totalSampleCount(chunks));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

function trimChunksToMaxSamples(chunks, maxSamples) {
  let total = totalSampleCount(chunks);
  while (total > maxSamples && chunks.length > 0) {
    total -= chunks[0].length;
    chunks.shift();
  }
}

function selectBestEmbeddingWindow(samples) {
  if (samples.length <= MAX_EMBEDDING_SAMPLES) return samples;

  const stride = SAMPLE_RATE;
  let bestStart = 0;
  let bestEnergy = -Infinity;

  for (let start = 0; start + MAX_EMBEDDING_SAMPLES <= samples.length; start += stride) {
    let energy = 0;
    for (let i = start; i < start + MAX_EMBEDDING_SAMPLES; i++) {
      energy += Math.abs(samples[i]);
    }
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestStart = start;
    }
  }

  return samples.subarray(bestStart, bestStart + MAX_EMBEDDING_SAMPLES);
}

function cloneFloat32Array(value) {
  return new Float32Array(value);
}

function normalizeVadShape(shape) {
  if (!Array.isArray(shape) || shape.length === 0) {
    return DEFAULT_VAD_STATE_SHAPE;
  }

  return shape.map((dim) => (typeof dim === "number" && dim > 0 ? dim : 1));
}

function normalizeVadStateName(name) {
  return String(name || "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function getBufferFloat32View(buffer) {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

class LiveSpeakerIdentifier {
  constructor() {
    this.session = null;
    this.running = false;
    this.queue = Promise.resolve();
    this.onSpeakerIdentified = null;
    this.getSpeakerProfiles = null;
    this.pcmRemainder = Buffer.alloc(0);
    this.audioRemainder = new Float32Array(0);
    this.vadStateInputs = [];
    this.vadStateOutputs = [];
    this.vadStates = new Map();
    this.speechChunks = [];
    this.speechActive = false;
    this.silenceWindows = 0;
    this.sampleCursor = 0;
    this.segmentStartSample = 0;
    this.segmentEndSample = 0;
    this.transientEmbeddings = new Map();
    this.transientCounts = new Map();
    this.transientDisplayNames = new Map();
    this.transientProfileIds = new Map();
    this.transientNoteIds = new Map();
    this.transientMergeOrigins = new Map();
    this.transientCohorts = new Map();
    this.transientVoicedSamples = new Map();
    this.transientObservations = new Map();
    this.transientMinimumSimilarity = new Map();
    this.anchors = new Map();
    this.activeRunId = null;
    this.nextLiveIndex = 0;
    this.currentSegmentSpeakerId = null;
    this.currentSegmentSpeakerName = null;
    this.lastLiveIdentificationSample = 0;
    this._diarizationManager = null;
    this.maxSpeakers = MAX_SPEAKER_COUNT;
    this.enabled = true;
  }

  setDiarizationManager(manager) {
    this._diarizationManager = manager;
  }

  isAvailable() {
    return (
      this._diarizationManager?.isVadModelDownloaded() &&
      speakerEmbeddings.isAvailable() &&
      loadOnnxRuntime() !== null
    );
  }

  getTransientState() {
    const state = {};

    for (const [speakerId, embedding] of this.transientEmbeddings.entries()) {
      state[speakerId] = {
        embedding: Array.from(embedding),
        displayName: this.transientDisplayNames.get(speakerId) || null,
        profileId: this.transientProfileIds.get(speakerId) ?? null,
        noteId: this.transientNoteIds.get(speakerId) ?? null,
      };
    }

    return state;
  }

  getSpeakerEmbedding(speakerId) {
    const embedding = this.transientEmbeddings.get(speakerId);
    return embedding ? cloneFloat32Array(embedding) : null;
  }

  getAnchorState(speakerId) {
    return this.anchors.get(speakerId)?.state || null;
  }

  hasActiveAnchor(noteId, runId) {
    this.revalidateAnchors();
    return [...this.anchors.values()].some(anchor => anchor.noteId === noteId && anchor.runId === runId);
  }

  invalidateAnchor(speakerId) {
    if (speakerId) this.anchors.delete(speakerId);
    else this.anchors.clear();
  }

  revalidateAnchors() {
    if (!this.anchors.size) return [];
    let profiles;
    try { profiles = this.getSpeakerProfiles?.() || []; }
    catch { profiles = []; }
    const removed = [];
    for (const [id, anchor] of this.anchors) {
      const profile = profiles.find(item => item.id === anchor.profileId && item.voice_usable === 1);
      if (!profile?.embedding || !Buffer.from(profile.embedding).equals(anchor.profileBytes)) {
        this.anchors.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  activateAnchor({ speakerId, profileId, rows, runId, noteId }) {
    this.invalidateAnchor(speakerId);
    const refused = (reason) => ({ state: 'refused', reason });
    if (!this.running || !runId || runId !== this.activeRunId || !speakerId ||
        !this.transientEmbeddings.has(speakerId) ||
        (this.transientCohorts.get(speakerId) || 'system') !== 'system')
      return refused('not_current_meeting');
    if (!profileId) return refused('not_graduated');
    if (!rows?.length || rows.some(row => row.speakerLockSource === 'user' && !row.speakerName))
      return refused('explicit_unknown');
    if (rows.some(row => row.source !== 'system' || row.audioSpan &&
      (row.audioSpan.trackId !== 'system' || row.audioSpan.recordingId !== noteId)))
      return refused('not_current_meeting');
    if (rows.some(row => row.speakerLocked || row.speakerLockSource === 'user')) return refused('locked');
    if (rows.some(row => row.overlap || row.uncertainty?.reason === 'overlapping_speech'))
      return refused('overlapping');
    if (rows.some(row => row.uncertainty?.reason === 'possible_mixed_speakers' || row.uncertainty))
      return refused('mixed');
    let profiles;
    try { profiles = this.getSpeakerProfiles?.() || []; }
    catch { return refused('not_graduated'); }
    const profile = profiles.find(item => item.id === profileId && item.voice_usable === 1);
    if (!profile) return refused('not_graduated');
    if ((this.transientVoicedSamples.get(speakerId) || 0) < ANCHOR_MIN_VOICED_SAMPLES ||
        (this.transientObservations.get(speakerId) || 0) < 2)
      return refused('too_short');
    if ((this.transientMinimumSimilarity.get(speakerId) ?? 1) < ANCHOR_MIN_CONSISTENCY)
      return refused('mixed');
    const centroid = this.getSpeakerEmbedding(speakerId);
    const profileVector = getBufferFloat32View(profile.embedding);
    const own = speakerEmbeddings.cosineSimilarity(centroid, profileVector);
    const alternatives = profiles.filter(item => item.id !== profileId).map(item =>
      speakerEmbeddings.cosineSimilarity(centroid, getBufferFloat32View(item.embedding)));
    for (const [id, other] of this.transientEmbeddings) if (id !== speakerId)
      alternatives.push(speakerEmbeddings.cosineSimilarity(centroid, other));
    if (own < MATCH_THRESHOLD || own - Math.max(0, ...alternatives) < ANCHOR_MARGIN)
      return refused('ambiguous_match');
    const state = { state: 'active', reason: null };
    this.anchors.set(speakerId, { state, centroid, profileId, runId, noteId, cohort: 'system',
      profileBytes: Buffer.from(profile.embedding) });
    return state;
  }

  async start(options = {}, extraOptions = {}) {
    const resolvedOptions =
      typeof options === "function" ? { onSpeakerIdentified: options, ...extraOptions } : options;
    const {
      onSpeakerIdentified = null,
      getSpeakerProfiles = null,
      maxSpeakers = MAX_SPEAKER_COUNT,
      enabled = true,
      speakerIndexBase = 0,
    } = resolvedOptions;

    this.onSpeakerIdentified =
      typeof onSpeakerIdentified === "function" ? onSpeakerIdentified : null;
    this.getSpeakerProfiles = typeof getSpeakerProfiles === "function" ? getSpeakerProfiles : null;
    this.maxSpeakers = clampMaxSpeakers(maxSpeakers);
    this.enabled = enabled !== false;
    this._resetMeetingState();
    // A resumed note already holds earlier sessions' ids; see speakerIndexBase.js.
    this.nextLiveIndex = normalizeSpeakerIndexBase(speakerIndexBase);

    if (!this.isAvailable()) {
      debugLogger.warn("Live speaker identifier unavailable", {
        vadModelPath: this._diarizationManager?.getVadModelPath(),
        embeddingModelAvailable: speakerEmbeddings.isAvailable(),
      });
      return false;
    }

    await this._ensureLoaded();
    this.running = !!this.session;
    return this.running;
  }

  async stop() {
    this.running = false;
    await this.queue;

    if (this.speechActive && this.audioRemainder.length > 0) {
      this.speechChunks.push(this.audioRemainder);
      this.audioRemainder = new Float32Array(0);
    }

    if (this.speechActive) {
      await this._finalizeSpeechSegment();
    }

    const transientState = this.getTransientState();
    this._resetMeetingState();
    this.onSpeakerIdentified = null;
    this.getSpeakerProfiles = null;
    return transientState;
  }

  recluster() {
    return new Promise((resolve) => {
      this.queue = this.queue
        .then(() => resolve(this._performRecluster()))
        .catch(() => resolve([]));
    });
  }

  _performRecluster() {
    const speakers = [...this.transientEmbeddings.entries()];
    if (speakers.length < 2) return [];

    const merges = [];
    const removed = new Set();

    for (let i = 0; i < speakers.length; i += 1) {
      if (removed.has(speakers[i][0])) continue;
      for (let j = i + 1; j < speakers.length; j += 1) {
        if (removed.has(speakers[j][0])) continue;
        if (this.transientCohorts.get(speakers[i][0]) !== this.transientCohorts.get(speakers[j][0])) continue;

        const similarity = speakerEmbeddings.cosineSimilarity(speakers[i][1], speakers[j][1]);
        if (similarity < RECLUSTER_SIMILARITY) continue;
        const bestAlternative = (index, otherIndex) => speakers.reduce((best, [id, embedding], k) =>
          k === index || k === otherIndex || removed.has(id)
            ? best
            : Math.max(best, speakerEmbeddings.cosineSimilarity(speakers[index][1], embedding)), 0);
        if (similarity - bestAlternative(i, j) < RECLUSTER_MARGIN ||
            similarity - bestAlternative(j, i) < RECLUSTER_MARGIN) continue;

        // Confirmed-distinct identities (different profiles, or different
        // user-set names) must never merge on embedding similarity alone.
        const profileI = this.transientProfileIds.get(speakers[i][0]);
        const profileJ = this.transientProfileIds.get(speakers[j][0]);
        if (profileI != null && profileJ != null && profileI !== profileJ) continue;
        const nameI = this.transientDisplayNames.get(speakers[i][0]);
        const nameJ = this.transientDisplayNames.get(speakers[j][0]);
        if (nameI && nameJ && nameI !== nameJ) continue;

        const countI = this.transientCounts.get(speakers[i][0]) || 1;
        const countJ = this.transientCounts.get(speakers[j][0]) || 1;
        const hasNameI = !!this.transientDisplayNames.get(speakers[i][0]);
        const hasNameJ = !!this.transientDisplayNames.get(speakers[j][0]);
        const keepFirst =
          hasNameI && !hasNameJ ? true : hasNameJ && !hasNameI ? false : countI >= countJ;
        const [keepId, removeId] = keepFirst
          ? [speakers[i][0], speakers[j][0]]
          : [speakers[j][0], speakers[i][0]];
        const keepCount = this.transientCounts.get(keepId) || 1;
        const removeCount = this.transientCounts.get(removeId) || 1;
        const keepEmb = this.transientEmbeddings.get(keepId);
        const removeEmb = this.transientEmbeddings.get(removeId);
        const totalCount = keepCount + removeCount;

        const merged = new Float32Array(keepEmb.length);
        for (let k = 0; k < keepEmb.length; k += 1) {
          merged[k] = (keepEmb[k] * keepCount + removeEmb[k] * removeCount) / totalCount;
        }

        this.transientEmbeddings.set(keepId, merged);
        this.transientCounts.set(keepId, totalCount);
        this.transientEmbeddings.delete(removeId);
        this.transientCounts.delete(removeId);
        this.transientCohorts.delete(removeId);
        this.transientVoicedSamples.delete(removeId);
        this.transientObservations.delete(removeId);
        this.transientMinimumSimilarity.delete(removeId);
        this.invalidateAnchor(keepId);
        this.invalidateAnchor(removeId);

        if (!this.transientDisplayNames.get(keepId) && this.transientDisplayNames.get(removeId)) {
          this.transientDisplayNames.set(keepId, this.transientDisplayNames.get(removeId));
        }
        this.transientDisplayNames.delete(removeId);

        if (!this.transientProfileIds.get(keepId) && this.transientProfileIds.get(removeId)) {
          this.transientProfileIds.set(keepId, this.transientProfileIds.get(removeId));
        }
        this.transientProfileIds.delete(removeId);

        if (!this.transientNoteIds.get(keepId) && this.transientNoteIds.get(removeId)) {
          this.transientNoteIds.set(keepId, this.transientNoteIds.get(removeId));
        }
        this.transientNoteIds.delete(removeId);

        if (this.currentSegmentSpeakerId === removeId) {
          this.currentSegmentSpeakerId = keepId;
        }

        removed.add(removeId);
        merges.push({
          keep: keepId,
          remove: removeId,
          displayName: this.transientDisplayNames.get(keepId) || null,
          similarity,
        });

        debugLogger.info("Speaker recluster merge", {
          keep: keepId,
          remove: removeId,
          similarity: similarity.toFixed(3),
          keepCount,
          removeCount,
        });
      }
    }

    return merges;
  }

  feedAudio(pcmBuffer) {
    if (!this.running || !pcmBuffer?.length) {
      return Promise.resolve();
    }

    this.queue = this.queue
      .then(() => this._processAudio(pcmBuffer))
      .catch((error) => {
        debugLogger.warn("Live speaker identification failed", { error: error.message });
      });

    return this.queue;
  }

  setMaxSpeakers(n) {
    this.maxSpeakers = clampMaxSpeakers(n);
  }

  setEnabled(enabled) {
    this.enabled = enabled !== false;
  }

  mapSpeaker(liveId, profileId, displayName, noteId) {
    if (!liveId || !this.transientEmbeddings.has(liveId)) {
      // Labeling a speaker in a past note routes here with no live session, so
      // only an active session losing a mapping is worth flagging.
      if (this.running) {
        debugLogger.warn("Live speaker mapping dropped: unknown speaker id", {
          liveId,
          hasDisplayName: !!displayName,
          knownSpeakers: [...this.transientEmbeddings.keys()],
        });
      }
      return false;
    }

    if (profileId != null) {
      this.transientProfileIds.set(liveId, profileId);
    } else {
      this.transientProfileIds.delete(liveId);
    }

    if (displayName) {
      this.transientDisplayNames.set(liveId, displayName);
    }

    if (noteId != null) {
      this.transientNoteIds.set(liveId, noteId);
    }

    return true;
  }

  unmapSpeaker(liveId, noteId) {
    if (noteId != null && this.transientNoteIds.get(liveId) !== noteId) return false;
    this.transientDisplayNames.delete(liveId);
    this.transientProfileIds.delete(liveId);
    this.transientNoteIds.delete(liveId);
    this.invalidateAnchor(liveId);
    if (this.currentSegmentSpeakerId === liveId) this.currentSegmentSpeakerName = null;
    return true;
  }

  reconcilePeopleMutation({ type, profileId, survivorId, displayName }) {
    if (['clear_voice', 'reset', 'delete', 'merge', 'undo_merge'].includes(type)) this.invalidateAnchor();
    if (type === 'clear_voice') {
      this.transientEmbeddings.clear();
      this.transientCounts.clear();
      this.transientCohorts.clear();
      this.transientVoicedSamples.clear();
      this.transientObservations.clear();
      this.transientMinimumSimilarity.clear();
      this.transientDisplayNames.clear();
      this.transientProfileIds.clear();
      this.transientNoteIds.clear();
      this.transientMergeOrigins.clear();
      this.currentSegmentSpeakerId = null;
      this.currentSegmentSpeakerName = null;
      return;
    }
    if (type === 'undo_merge') {
      for (const [speakerId, id] of this.transientProfileIds) {
        const origins = this.transientMergeOrigins.get(speakerId);
        if (id !== survivorId || origins?.at(-1)?.profileId !== profileId) continue;
        const previous = origins.pop();
        if (!origins.length) this.transientMergeOrigins.delete(speakerId);
        this.transientProfileIds.set(speakerId, profileId);
        this.transientDisplayNames.set(speakerId, previous.displayName || displayName);
        if (this.currentSegmentSpeakerId === speakerId)
          this.currentSegmentSpeakerName = previous.displayName || displayName;
      }
      return;
    }
    for (const [speakerId, id] of this.transientProfileIds) {
      if (id !== profileId) continue;
      if (type === 'delete' || type === 'reset') {
        this.transientEmbeddings.delete(speakerId);
        this.transientCounts.delete(speakerId);
        this.transientCohorts.delete(speakerId);
        this.transientVoicedSamples.delete(speakerId);
        this.transientObservations.delete(speakerId);
        this.transientMinimumSimilarity.delete(speakerId);
        this.transientDisplayNames.delete(speakerId);
        this.transientProfileIds.delete(speakerId);
        this.transientNoteIds.delete(speakerId);
        this.transientMergeOrigins.delete(speakerId);
        if (this.currentSegmentSpeakerId === speakerId) {
          this.currentSegmentSpeakerId = null;
          this.currentSegmentSpeakerName = null;
        }
      } else {
        if (type === 'merge') {
          const origins = this.transientMergeOrigins.get(speakerId) || [];
          origins.push({ profileId, displayName: this.transientDisplayNames.get(speakerId) });
          this.transientMergeOrigins.set(speakerId, origins);
          this.transientProfileIds.set(speakerId, survivorId);
        }
        this.transientDisplayNames.set(speakerId, displayName);
        if (this.currentSegmentSpeakerId === speakerId) this.currentSegmentSpeakerName = displayName;
      }
    }
  }

  async _ensureLoaded() {
    if (this.session) return;

    const vadModelPath = this._diarizationManager?.getVadModelPath();
    if (!fs.existsSync(vadModelPath)) {
      return;
    }

    const ort = loadOnnxRuntime();
    if (!ort) return;

    this.session = await ort.InferenceSession.create(vadModelPath, VAD_SESSION_OPTIONS);
    this.vadStateInputs = (this.session.inputNames || []).filter((name) => /state|h|c/i.test(name));
    this.vadStateOutputs = (this.session.outputNames || []).filter((name) =>
      /state|h|c/i.test(name)
    );
    this._resetVadRuntimeState();
  }

  _resetMeetingState() {
    this.queue = Promise.resolve();
    this.pcmRemainder = Buffer.alloc(0);
    this.audioRemainder = new Float32Array(0);
    this.speechChunks = [];
    this.speechActive = false;
    this.silenceWindows = 0;
    this.sampleCursor = 0;
    this.segmentStartSample = 0;
    this.segmentEndSample = 0;
    this.transientEmbeddings = new Map();
    this.transientCounts = new Map();
    this.transientDisplayNames = new Map();
    this.transientProfileIds = new Map();
    this.transientNoteIds = new Map();
    this.transientMergeOrigins = new Map();
    this.transientCohorts = new Map();
    this.transientVoicedSamples = new Map();
    this.transientObservations = new Map();
    this.transientMinimumSimilarity = new Map();
    this.anchors = new Map();
    this.nextLiveIndex = 0;
    this.currentSegmentSpeakerId = null;
    this.currentSegmentSpeakerName = null;
    this.lastLiveIdentificationSample = 0;
    this._resetVadRuntimeState();
  }

  _resetVadRuntimeState() {
    this.vadStates = new Map();

    if (!this.session) {
      return;
    }

    for (const name of this.vadStateInputs) {
      const metadata = this.session.inputMetadata?.[name];
      const shape = normalizeVadShape(metadata?.dimensions || metadata?.shape);
      const size = shape.reduce((total, dim) => total * dim, 1);
      this.vadStates.set(name, new Float32Array(size));
    }
  }

  async _processAudio(pcmBuffer) {
    await this._ensureLoaded();
    if (!this.session) return;

    // Carry the bytes past the last whole resample group into the next buffer.
    // The concat copies into a new buffer, so the Int16 view never inherits the
    // caller's byteOffset.
    const incoming = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);
    const pending = Buffer.concat([this.pcmRemainder, incoming]);
    const usableBytes = pending.length - (pending.length % RESAMPLE_GROUP_BYTES);
    this.pcmRemainder = Buffer.from(pending.subarray(usableBytes));
    if (!usableBytes) return;

    const downsampled = downsample24kTo16k(pending.subarray(0, usableBytes));
    if (!downsampled.length) return;

    this.audioRemainder = appendFloat32(this.audioRemainder, pcm16ToFloat32(downsampled));

    while (this.audioRemainder.length >= VAD_WINDOW_SIZE) {
      const window = this.audioRemainder.subarray(0, VAD_WINDOW_SIZE);
      this.audioRemainder = this.audioRemainder.slice(VAD_WINDOW_SIZE);

      const windowStartSample = this.sampleCursor;
      this.sampleCursor += window.length;

      await this._processWindow(window, windowStartSample, this.sampleCursor);
    }
  }

  async _processWindow(window, windowStartSample, windowEndSample) {
    const probability = await this._getVadProbability(window);

    if (this.speechActive) {
      this.speechChunks.push(cloneFloat32Array(window));
      trimChunksToMaxSamples(this.speechChunks, SPEECH_CHUNKS_MAX_SAMPLES);
      this.segmentEndSample = windowEndSample;

      if (probability >= SILENCE_THRESHOLD) {
        this.silenceWindows = 0;
        await this._identifyActiveSpeechSegment();
        return;
      }

      this.silenceWindows += 1;
      if (this.silenceWindows >= SILENCE_WINDOWS_TO_END) {
        await this._finalizeSpeechSegment();
      }
      return;
    }

    if (probability < SPEECH_THRESHOLD) {
      return;
    }

    this.speechActive = true;
    this.segmentStartSample = windowStartSample;
    this.segmentEndSample = windowEndSample;
    this.speechChunks = [cloneFloat32Array(window)];
    this.silenceWindows = 0;
    this.currentSegmentSpeakerId = null;
    this.currentSegmentSpeakerName = null;
    this.lastLiveIdentificationSample = 0;
  }

  async _getVadProbability(window) {
    if (!this.session) return 0;

    const ort = loadOnnxRuntime();
    if (!ort) return 0;
    const feeds = {};
    const audioInputName = (this.session.inputNames || []).find(
      (name) => !this.vadStateInputs.includes(name) && !/sr|sample.?rate/i.test(name)
    );

    if (!audioInputName) {
      return 0;
    }

    feeds[audioInputName] = new ort.Tensor("float32", window, [1, window.length]);

    const sampleRateInputName = (this.session.inputNames || []).find((name) =>
      /sr|sample.?rate/i.test(name)
    );
    if (sampleRateInputName) {
      feeds[sampleRateInputName] = new ort.Tensor(
        "int64",
        BigInt64Array.from([BigInt(SAMPLE_RATE)]),
        [1]
      );
    }

    for (const stateName of this.vadStateInputs) {
      const metadata = this.session.inputMetadata?.[stateName];
      const shape = normalizeVadShape(metadata?.dimensions || metadata?.shape);
      const state =
        this.vadStates.get(stateName) || new Float32Array(shape.reduce((a, b) => a * b, 1));

      this.vadStates.set(stateName, state);
      feeds[stateName] = new ort.Tensor("float32", state, shape);
    }

    const results = await this.session.run(feeds);
    this._updateVadState(results);

    const outputName = (this.session.outputNames || []).find(
      (name) => !this.vadStateOutputs.includes(name)
    );
    const output = (outputName && results[outputName]) || Object.values(results)[0];
    const value = output?.data?.[0];
    return typeof value === "number" ? value : 0;
  }

  _updateVadState(results) {
    if (!results) {
      return;
    }

    for (const inputName of this.vadStateInputs) {
      const expectedName = normalizeVadStateName(inputName);
      const matchingOutput = this.vadStateOutputs.find((outputName) =>
        normalizeVadStateName(outputName).startsWith(expectedName)
      );
      const output = (matchingOutput && results[matchingOutput]) || results[inputName];

      if (output?.data) {
        this.vadStates.set(inputName, new Float32Array(output.data));
      }
    }
  }

  async _identifyActiveSpeechSegment(force = false) {
    // Runs on every speech window (~31x/sec), so the cheap gates must come
    // first — concatenating up to 32s of float32 per window is ~64 MB/s of
    // wasted main-thread memcpy during continuous speech.
    if (totalSampleCount(this.speechChunks) < LIVE_IDENTIFICATION_MIN_SAMPLES) {
      return;
    }

    if (
      !force &&
      this.lastLiveIdentificationSample > 0 &&
      this.segmentEndSample - this.lastLiveIdentificationSample <
        LIVE_IDENTIFICATION_INTERVAL_SAMPLES
    ) {
      return;
    }

    const allSamples = concatFloat32Arrays(this.speechChunks);
    const currentSamples =
      allSamples.length > MAX_EMBEDDING_SAMPLES
        ? allSamples.subarray(allSamples.length - MAX_EMBEDDING_SAMPLES)
        : allSamples;

    const embedding = await speakerEmbeddings.extractEmbeddingFromSamples(currentSamples);
    if (!embedding) {
      return;
    }

    const resolved = this._resolveSpeakerForEmbedding(embedding, { updateCentroid: false });
    if (!resolved?.speakerId) {
      return;
    }

    this.currentSegmentSpeakerId = resolved.speakerId;
    this.currentSegmentSpeakerName = resolved.displayName || null;
    this.lastLiveIdentificationSample = this.segmentEndSample;

    if (!this.enabled) return;

    this.onSpeakerIdentified?.({
      speakerId: resolved.speakerId,
      displayName: resolved.displayName || null,
      uncertainty: resolved.uncertainty,
      startTime: Math.max(0, this.segmentStartSample / SAMPLE_RATE - LIVE_WINDOW_PADDING_SECONDS),
      endTime: this.segmentEndSample / SAMPLE_RATE + LIVE_WINDOW_PADDING_SECONDS,
    });
  }

  async _finalizeSpeechSegment() {
    const samples = concatFloat32Arrays(this.speechChunks);
    this.speechChunks = [];
    this.speechActive = false;
    this.silenceWindows = 0;

    if (samples.length < MIN_SEGMENT_SAMPLES) {
      return;
    }

    const embedding = await speakerEmbeddings.extractEmbeddingFromSamples(
      selectBestEmbeddingWindow(samples)
    );
    if (!embedding) {
      return;
    }

    const resolved = this._resolveSpeakerForEmbedding(embedding, { updateCentroid: true,
      voicedSamples: samples.length });
    if (!resolved?.speakerId) {
      return;
    }

    const speakerId = resolved.speakerId;
    const displayName = resolved.uncertainty ? null :
      resolved.displayName || this.currentSegmentSpeakerName ||
      this.transientDisplayNames.get(speakerId) || null;

    if (this.enabled) {
      this.onSpeakerIdentified?.({
        speakerId,
        displayName,
        uncertainty: resolved.uncertainty,
        startTime: Math.max(0, this.segmentStartSample / SAMPLE_RATE - LIVE_WINDOW_PADDING_SECONDS),
        endTime: this.segmentEndSample / SAMPLE_RATE + LIVE_WINDOW_PADDING_SECONDS,
      });
    }

    this.currentSegmentSpeakerId = null;
    this.currentSegmentSpeakerName = null;
    this.lastLiveIdentificationSample = 0;
  }

  _findTransientMatch(embedding, cohort = 'system') {
    let bestSpeakerId = null;
    let bestSimilarity = 0;
    let secondBestSimilarity = 0;

    for (const [speakerId, centroid] of this.transientEmbeddings.entries()) {
      if ((this.transientCohorts.get(speakerId) || 'system') !== cohort) continue;
      const similarity = speakerEmbeddings.cosineSimilarity(embedding, centroid);
      if (similarity > bestSimilarity) {
        secondBestSimilarity = bestSimilarity;
        bestSimilarity = similarity;
        bestSpeakerId = speakerId;
      } else if (similarity > secondBestSimilarity) {
        secondBestSimilarity = similarity;
      }
    }

    return bestSimilarity >= MATCH_THRESHOLD &&
      bestSimilarity - secondBestSimilarity >= MATCH_MARGIN
      ? bestSpeakerId
      : null;
  }

  _findStoredProfileMatch(embedding) {
    let profiles = [];

    try {
      profiles = this.getSpeakerProfiles?.() || [];
    } catch (error) {
      debugLogger.debug("Live speaker profile lookup failed", { error: error.message });
      return null;
    }

    let bestProfile = null;
    let bestSimilarity = 0;
    let secondBestSimilarity = 0;

    for (const profile of profiles) {
      if (!profile?.embedding) continue;

      const profileEmbedding =
        profile.embedding instanceof Float32Array
          ? profile.embedding
          : Array.isArray(profile.embedding)
            ? new Float32Array(profile.embedding)
            : getBufferFloat32View(profile.embedding);

      if (!profileEmbedding.length) continue;

      const similarity = speakerEmbeddings.cosineSimilarity(embedding, profileEmbedding);
      if (similarity > bestSimilarity) {
        secondBestSimilarity = bestSimilarity;
        bestSimilarity = similarity;
        bestProfile = profile;
      } else if (similarity > secondBestSimilarity) {
        secondBestSimilarity = similarity;
      }
    }

    return bestSimilarity >= MATCH_THRESHOLD &&
      bestSimilarity - secondBestSimilarity >= MATCH_MARGIN
      ? bestProfile
      : null;
  }

  _resolveSpeakerForEmbedding(embedding, options = {}) {
    const { updateCentroid = false, voicedSamples = 0, cohort = 'system' } = options;
    this.revalidateAnchors();
    const comparable = [...this.anchors].filter(([, anchor]) =>
      anchor.runId === this.activeRunId && anchor.cohort === cohort);
    if (comparable.length) {
      const ranked = comparable.map(([id, anchor]) => ({ id, anchor,
        similarity: speakerEmbeddings.cosineSimilarity(embedding, anchor.centroid) }))
        .sort((a, b) => b.similarity - a.similarity);
      const best = ranked[0];
      let runnerUp = Math.max(0, ranked[1]?.similarity || 0);
      for (const [id, other] of this.transientEmbeddings)
        if (id !== best.id && !this.anchors.has(id) &&
            (this.transientCohorts.get(id) || 'system') === cohort)
          runnerUp = Math.max(runnerUp, speakerEmbeddings.cosineSimilarity(embedding, other));
      let profiles = [];
      try { profiles = this.getSpeakerProfiles?.() || []; } catch { /* transient comparison still works */ }
      for (const profile of profiles) if (profile.id !== best.anchor.profileId && profile.embedding)
        runnerUp = Math.max(runnerUp, speakerEmbeddings.cosineSimilarity(embedding,
          getBufferFloat32View(profile.embedding)));
      if (best.similarity >= ANCHOR_THRESHOLD && best.similarity - runnerUp >= ANCHOR_MARGIN)
        return { speakerId: best.id, displayName: this.transientDisplayNames.get(best.id) || null };
      // A confirmed label does not make disagreeing audio belong to it.
      const transient = this.currentSegmentSpeakerId || this._findTransientMatch(embedding, cohort);
      const profile = this._findStoredProfileMatch(embedding);
      if (best.similarity >= 0.5 || transient && this.anchors.has(transient) ||
          profile && ranked.some(item => item.anchor.profileId === profile.id)) {
        const speakerId = this._assignCluster(embedding, voicedSamples, cohort);
        return { speakerId, displayName: null, uncertainty: { reason: 'close_match' } };
      }
    }

    let speakerId = this.currentSegmentSpeakerId &&
      (this.transientCohorts.get(this.currentSegmentSpeakerId) || 'system') === cohort
      ? this.currentSegmentSpeakerId : this._findTransientMatch(embedding, cohort);
    let displayName = this.currentSegmentSpeakerId === speakerId
      ? this.currentSegmentSpeakerName || null : null;

    if (speakerId) {
      if (updateCentroid) {
        this._updateCentroid(speakerId, embedding, voicedSamples);
      }

      return {
        speakerId,
        displayName: displayName || this.transientDisplayNames.get(speakerId) || null,
      };
    }

    const matchedProfile = this._findStoredProfileMatch(embedding);
    if (matchedProfile) {
      speakerId = this._findTransientSpeakerForProfile(matchedProfile.id, cohort);
      if (!speakerId) {
        speakerId = this._assignCluster(embedding, voicedSamples, cohort);
      } else if (updateCentroid) {
        this._updateCentroid(speakerId, embedding, voicedSamples);
      }

      this.transientProfileIds.set(speakerId, matchedProfile.id);
      this.transientDisplayNames.set(speakerId, matchedProfile.display_name);
      return {
        speakerId,
        displayName: matchedProfile.display_name,
      };
    }

    speakerId = this.currentSegmentSpeakerId &&
      (this.transientCohorts.get(this.currentSegmentSpeakerId) || 'system') === cohort
      ? this.currentSegmentSpeakerId : null;
    if (speakerId) {
      if (updateCentroid) {
        this._updateCentroid(speakerId, embedding, voicedSamples);
      }
    } else {
      speakerId = this._assignCluster(embedding, voicedSamples, cohort);
    }

    return {
      speakerId,
      displayName: this.transientDisplayNames.get(speakerId) || null,
    };
  }

  _assignCluster(embedding, voicedSamples = 0, cohort = 'system') {
    // A count is a request, not evidence that a new voice is an old one.
    return this._assignSpeakerId(embedding, voicedSamples, cohort);
  }

  _findTransientSpeakerForProfile(profileId, cohort = 'system') {
    for (const [speakerId, candidateProfileId] of this.transientProfileIds.entries()) {
      if (candidateProfileId === profileId &&
          (this.transientCohorts.get(speakerId) || 'system') === cohort) {
        return speakerId;
      }
    }

    return null;
  }

  // Cluster ids double as the transcript's speaker labels. Ids freed by a
  // recluster merge are never reused: durable state (note speaker mappings,
  // the renderer's name map) may still reference them, and a recycled id would
  // let a new voice inherit the previous person's identity.
  _assignSpeakerId(embedding, voicedSamples = 0, cohort = 'system') {
    const speakerId = `speaker_${this.nextLiveIndex}`;
    this.nextLiveIndex += 1;
    this.transientEmbeddings.set(speakerId, cloneFloat32Array(embedding));
    this.transientCohorts.set(speakerId, cohort);
    this.transientCounts.set(speakerId, 1);
    this.transientVoicedSamples.set(speakerId, voicedSamples);
    this.transientObservations.set(speakerId, voicedSamples ? 1 : 0);
    this.transientMinimumSimilarity.set(speakerId, 1);
    return speakerId;
  }

  _updateCentroid(speakerId, embedding, voicedSamples = 0) {
    const centroid = this.transientEmbeddings.get(speakerId);
    if (!centroid) {
      return;
    }

    const count = this.transientCounts.get(speakerId) || 1;
    if (voicedSamples) {
      this.transientVoicedSamples.set(speakerId,
        (this.transientVoicedSamples.get(speakerId) || 0) + voicedSamples);
      this.transientObservations.set(speakerId,
        (this.transientObservations.get(speakerId) || 0) + 1);
      this.transientMinimumSimilarity.set(speakerId, Math.min(
        this.transientMinimumSimilarity.get(speakerId) ?? 1,
        speakerEmbeddings.cosineSimilarity(embedding, centroid)));
    }
    const nextCentroid = new Float32Array(embedding.length);

    for (let i = 0; i < embedding.length; i += 1) {
      nextCentroid[i] = (centroid[i] * count + embedding[i]) / (count + 1);
    }

    this.transientEmbeddings.set(speakerId, nextCentroid);
    this.transientCounts.set(speakerId, count + 1);
  }
}

const instance = new LiveSpeakerIdentifier();
module.exports = instance;
module.exports.LiveSpeakerIdentifier = LiveSpeakerIdentifier;
