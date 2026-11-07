const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { intervalIndex } = require("./calibrationEvidenceIndex");
const { exactCoverage } = require("./voiceAudioIntegrity");

// Worker-only read session. Manifests/intervals are indexed once; a row reads
// only its intersecting five-second source chunks. Decodes are memoized per
// recording, with encrypted spill files so long recordings cannot exhaust RAM.
function createSession(store, directory, { cacheBytes = 32 * 1024 * 1024 } = {}) {
  const session = Object.create(store);
  const manifests = new Map();
  const indexes = new WeakMap();
  const inputs = new Map();
  const decoded = new Map();
  let inputBytes = 0,
    decodedBytes = 0,
    currentNote;
  const limit = cacheBytes;
  let spillAvailable = true;
  const spill = path.join(directory, "pcm-cache");
  fs.mkdirSync(spill, { mode: 0o700 });
  session.metrics = {
    provenanceReads: 0,
    decodes: 0,
    sourceChunkReads: 0,
    get decodedBytes() {
      return decodedBytes;
    },
  };
  session._manifest = (noteId) => {
    if (!manifests.has(noteId)) manifests.set(noteId, store._manifest(noteId, true));
    return manifests.get(noteId);
  };
  session.recordingProvenance = (...args) => {
    session.metrics.provenanceReads++;
    return store.recordingProvenance.apply(session, args);
  };
  session._readSpanChunk = (noteId, chunk) => {
    const key = `${noteId}:${chunk.file}`;
    if (!inputs.has(key)) {
      const value = store._readSpanChunk(noteId, chunk);
      session.metrics.sourceChunkReads++;
      inputs.set(key, value);
      inputBytes += value.ogg.length;
      while (inputBytes > limit && inputs.size > 1) {
        const first = inputs.keys().next().value;
        inputBytes -= inputs.get(first).ogg.length;
        inputs.delete(first);
      }
      return value;
    }
    return { ...inputs.get(key), bytesRead: 0 };
  };
  session.codec = {
    async decodeAsync(ogg, options) {
      options.signal?.throwIfAborted();
      const key = createHash("sha256").update(ogg).digest("hex");
      const cached = decoded.get(key);
      if (cached) return cached.pcm || store.encryption.decryptBytes(fs.readFileSync(cached.file));
      const pcm = await (store.codec.decodeAsync?.(ogg, options) ?? store.codec.decode(ogg));
      session.metrics.decodes++;
      decoded.set(key, { pcm });
      decodedBytes += pcm.length;
      if (decodedBytes > limit) {
        for (const [hash, value] of decoded) {
          if (!value.pcm) continue;
          const file = path.join(spill, hash);
          if (spillAvailable) {
            try {
              fs.writeFileSync(file, store.encryption.encryptBytes(value.pcm), { mode: 0o600 });
              value.file = file;
            } catch {
              // A full/unavailable disk must not defeat the memory bound or
              // turn a partial file into a cache hit. Re-decode after eviction.
              spillAvailable = false;
              try {
                fs.rmSync(file, { force: true });
              } catch {
                /* Job cleanup retries. */
              }
            }
          }
          decodedBytes -= value.pcm.length;
          delete value.pcm;
          if (!value.file) decoded.delete(hash);
          if (decodedBytes <= limit) break;
        }
      }
      return pcm;
    },
  };
  session.spanAsync = async (noteId, track, start, end, options) => {
    if (currentNote !== noteId) {
      inputs.clear();
      decoded.clear();
      inputBytes = decodedBytes = 0;
      fs.rmSync(spill, { recursive: true, force: true });
      fs.mkdirSync(spill, { mode: 0o700 });
      currentNote = noteId;
    }
    const manifest = session._manifest(noteId);
    const state = manifest?.tracks?.[track];
    if (!state) return store.spanAsync.call(session, noteId, track, start, end, options);
    if (!indexes.has(state)) {
      const valid = state.chunks.every((chunk) =>
        exactCoverage([chunk], chunk.startSample, chunk.startSample + chunk.sampleCount)
      );
      indexes.set(state, {
        valid,
        chunks: intervalIndex(
          state.chunks,
          (c) => c.startSample,
          (c) => c.startSample + c.sampleCount
        ),
        gaps: intervalIndex(
          state.gaps || [],
          (g) => g.startSample,
          (g) => g.endSample
        ),
      });
    }
    const index = indexes.get(state);
    const from = Math.round(start * 24000),
      to = Math.round(end * 24000);
    const selected = {
      ...state,
      chunks: index.valid ? index.chunks.select(from, to) : state.chunks,
      gaps: index.gaps.select(from, to),
    };
    const view = Object.create(session);
    view._manifest = () => ({ ...manifest, tracks: { ...manifest.tracks, [track]: selected } });
    return store.spanAsync.call(view, noteId, track, start, end, options);
  };
  session.close = () => {
    inputs.clear();
    decoded.clear();
    manifests.clear();
    inputBytes = decodedBytes = 0;
  };
  return session;
}
module.exports = { createSession };
