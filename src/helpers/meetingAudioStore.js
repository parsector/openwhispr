const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { getFFmpegPath } = require("./ffmpegUtils");
const { encryptBytes, decryptBytes } = require("./secretCrypto");

const RATE = 24000;
const CHUNK_SAMPLES = RATE * 5;
const DEFAULT_BUDGET = 2 * 1024 * 1024 * 1024;
const TRACKS = ["mic", "system"];

function writeJsonAtomic(file, value) {
  const temp = `${file}.pending`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function encode(pcm) {
  const result = spawnSync(getFFmpegPath(), [
    "-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", String(RATE),
    "-ac", "1", "-i", "pipe:0", "-c:a", "libopus", "-b:a", "32k",
    "-application", "audio", "-f", "ogg", "pipe:1",
  ], { input: pcm, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0 || !result.stdout?.length) {
    throw new Error(`Audio encoding failed: ${String(result.stderr || result.error || "unknown error")}`);
  }
  return result.stdout;
}

function decode(ogg) {
  const result = spawnSync(getFFmpegPath(), [
    "-hide_banner", "-loglevel", "error", "-f", "ogg", "-i", "pipe:0",
    "-f", "s16le", "-ar", String(RATE), "-ac", "1", "pipe:1",
  ], { input: ogg, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0) throw new Error("Stored audio could not be decoded");
  return result.stdout;
}

function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function packet(entry, ogg) {
  const header = Buffer.from(JSON.stringify(entry), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(header.length);
  return Buffer.concat([length, header, ogg]);
}

function unpack(bytes) {
  const length = bytes.readUInt32LE(0);
  if (length < 2 || length > 4096 || 4 + length > bytes.length) throw new Error("Invalid audio chunk header");
  return { entry: JSON.parse(bytes.subarray(4, 4 + length).toString("utf8")), ogg: bytes.subarray(4 + length) };
}

class MeetingAudioStore {
  constructor(root, { database = null, now = Date.now, encryption = { encryptBytes, decryptBytes }, onEvicted = null } = {}) {
    this.root = root;
    this.database = database;
    this.now = now;
    this.encryption = encryption;
    this.onEvicted = onEvicted;
    this.active = new Map();
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.policyFile = path.join(root, "policy.json");
    this.policy = this._readJson(this.policyFile) || { days: 3, budgetBytes: DEFAULT_BUDGET };
    this.noticeFile = path.join(root, "evictions.json");
    this.evictions = this._readJson(this.noticeFile) || [];
    this.repair();
    this.enforce();
  }

  _readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  }

  _dir(noteId) { return path.join(this.root, String(noteId)); }
  _manifestPath(noteId) { return path.join(this._dir(noteId), "manifest.json"); }
  _manifest(noteId) { return this._readJson(this._manifestPath(noteId)); }
  _noteId(noteId) {
    if (!Number.isSafeInteger(noteId) || noteId <= 0) throw new Error("Invalid meeting note ID");
    return noteId;
  }

  begin(noteId, startedAt = this.now()) {
    this._noteId(noteId);
    // Probe the key before creating a directory or accepting audio. A keychain
    // outage leaves the transcript path operational and marks audio incomplete.
    this.encryption.encryptBytes(Buffer.from("probe"));
    const dir = this._dir(noteId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let manifest = this._manifest(noteId);
    const prior = manifest && TRACKS.flatMap((track) => manifest.tracks?.[track]?.chunks || [])[0];
    if (prior) {
      try { this.encryption.decryptBytes(fs.readFileSync(path.join(dir, prior.file))); }
      catch { throw new Error("Audio encryption key is unavailable for this meeting"); }
    }
    if (!manifest || !manifest.tracks?.mic || !manifest.tracks?.system ||
      !["recording", "complete", "incomplete"].includes(manifest.status)) {
      manifest = {
        version: 1, noteId, startedAt, status: "recording",
        retentionDays: this.policy.days, keep: false, reason: null,
        tracks: Object.fromEntries(TRACKS.map((track) => [track, {
          startedAt, sampleRate: RATE, codec: "ogg/opus", byteLength: 0,
          sampleCount: 0, chunks: [],
        }])),
      };
      writeJsonAtomic(this._manifestPath(noteId), manifest);
    } else {
      manifest.status = "recording";
      manifest.reason = null;
      writeJsonAtomic(this._manifestPath(noteId), manifest);
    }
    this.active.set(noteId, { manifest, pending: { mic: Buffer.alloc(0), system: Buffer.alloc(0) },
      firstChunk: { mic: true, system: true } });
    return manifest;
  }

  append(noteId, track, pcm, capturedAt = this.now()) {
    if (!TRACKS.includes(track)) throw new Error("Invalid meeting audio track");
    const session = this.active.get(noteId);
    if (!session) return;
    const input = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
    if (input.length % 2) throw new Error("PCM chunk has an odd byte length");
    if (session.firstChunk[track]) {
      const state = session.manifest.tracks[track];
      const cursor = Math.max(state.sampleCount,
        Math.round(Math.max(0, capturedAt - session.manifest.startedAt) * RATE / 1000));
      if (cursor > state.sampleCount) {
        (state.gaps ||= []).push({ startSample: state.sampleCount, endSample: cursor });
        state.sampleCount = cursor;
      }
      if (!state.chunks.length) state.startedAt = capturedAt;
      session.firstChunk[track] = false;
      writeJsonAtomic(this._manifestPath(noteId), session.manifest);
    }
    let pending = Buffer.concat([session.pending[track], input]);
    while (pending.length >= CHUNK_SAMPLES * 2) {
      this._flush(noteId, track, pending.subarray(0, CHUNK_SAMPLES * 2));
      pending = pending.subarray(CHUNK_SAMPLES * 2);
    }
    session.pending[track] = pending;
  }

  _flush(noteId, track, pcm) {
    if (!pcm.length) return;
    const session = this.active.get(noteId);
    const state = session.manifest.tracks[track];
    const index = state.chunks.length;
    const startSample = state.sampleCount;
    const sampleCount = pcm.length / 2;
    const filename = `${track}-${String(index).padStart(7, "0")}.owac`;
    const entry = { file: filename, startSample, sampleCount };
    const payload = this.encryption.encryptBytes(packet(entry, encode(pcm)));
    entry.byteLength = payload.length;
    const budget = this.enforce(payload.length);
    if (budget.usedBytes + payload.length > budget.budgetBytes) {
      throw new Error("Meeting audio disk budget is full");
    }
    // The authenticated chunk is durable before its index entry. Repair can
    // recover a chunk if the process dies before the manifest rename.
    const chunkFile = path.join(this._dir(noteId), filename);
    fs.writeFileSync(chunkFile, payload, { flag: "wx", mode: 0o600 });
    state.chunks.push(entry);
    state.sampleCount += sampleCount;
    state.byteLength += payload.length;
    writeJsonAtomic(this._manifestPath(noteId), session.manifest);
  }

  finish(noteId) {
    const session = this.active.get(noteId);
    if (!session) return;
    try {
      for (const track of TRACKS) this._flush(noteId, track, session.pending[track]);
      session.manifest.status = "complete";
      session.manifest.endedAt = this.now();
      writeJsonAtomic(this._manifestPath(noteId), session.manifest);
    } finally {
      this.active.delete(noteId);
      this.enforce();
    }
  }

  fail(noteId, reason) {
    const session = this.active.get(noteId);
    let manifest = session?.manifest || this._manifest(noteId);
    this.active.delete(noteId);
    if (!manifest) {
      this._noteId(noteId);
      fs.mkdirSync(this._dir(noteId), { recursive: true, mode: 0o700 });
      manifest = { version: 1, noteId, startedAt: this.now(), retentionDays: this.policy.days,
        keep: false, tracks: {} };
    }
    manifest.status = "incomplete";
    manifest.reason = reason || "Audio capture failed";
    writeJsonAtomic(this._manifestPath(noteId), manifest);
  }

  repair() {
    for (const name of fs.readdirSync(this.root)) {
      if (!/^\d+$/.test(name)) continue;
      const noteId = Number(name);
      const manifest = this._manifest(noteId);
      if (!manifest || manifest.version !== 1) continue;
      let changed = false;
      if (manifest.status === "recording") {
        manifest.status = "incomplete";
        manifest.reason = "Meeting was interrupted";
        changed = true;
      }
      for (const track of TRACKS) {
        const state = manifest.tracks?.[track];
        if (!state) continue;
        const entries = [];
        let sampleCount = 0;
        let byteLength = 0;
        for (const fileName of fs.readdirSync(this._dir(noteId)).filter((file) =>
          new RegExp(`^${track}-\\d{7}\\.owac$`).test(file)).sort()) {
          const file = path.join(this._dir(noteId), fileName);
          try {
            const bytes = fs.readFileSync(file);
            const { entry } = unpack(this.encryption.decryptBytes(bytes));
            if (entry.file !== fileName || !Number.isSafeInteger(entry.startSample) ||
              !Number.isSafeInteger(entry.sampleCount) || entry.sampleCount <= 0) throw new Error("Bad audio index");
            entries.push({ ...entry, byteLength: bytes.length });
            sampleCount = Math.max(sampleCount, entry.startSample + entry.sampleCount);
            byteLength += bytes.length;
          } catch {
            // A missing or changed key must never rewrite the manifest around
            // undecryptable ciphertext. It can be repaired after key recovery.
            if (changed) writeJsonAtomic(this._manifestPath(noteId), manifest);
            return;
          }
        }
        if (entries.length !== state.chunks.length || entries.some((entry, index) =>
          entry.file !== state.chunks[index]?.file)) changed = true;
        state.chunks = entries;
        if (state.sampleCount !== sampleCount || state.byteLength !== byteLength) changed = true;
        state.sampleCount = sampleCount;
        state.byteLength = byteLength;
      }
      if (changed) writeJsonAtomic(this._manifestPath(noteId), manifest);
    }
  }

  status(noteId) {
    this._noteId(noteId);
    const manifest = this._manifest(noteId);
    if (!manifest) return { state: "unavailable", bytes: 0 };
    const result = {
      state: manifest.status, reason: manifest.reason,
      bytes: TRACKS.reduce((sum, track) => sum + (manifest.tracks?.[track]?.byteLength || 0), 0),
      tracks: manifest.tracks,
      startedAt: manifest.startedAt,
      keep: manifest.keep,
    };
    const first = TRACKS.flatMap((track) => manifest.tracks?.[track]?.chunks || [])[0];
    if (first) {
      const file = path.join(this._dir(noteId), first.file);
      if (!fs.existsSync(file)) { result.state = "unavailable"; result.reason = "Stored audio chunk is missing"; }
      else {
        try { this.encryption.decryptBytes(fs.readFileSync(file)); }
        catch { result.state = "key_unavailable"; result.reason = "Audio encryption key is unavailable"; }
      }
    }
    return result;
  }

  span(noteId, track, startSeconds, endSeconds) {
    this._noteId(noteId);
    if (!TRACKS.includes(track) || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) ||
      startSeconds < 0 || endSeconds <= startSeconds || endSeconds - startSeconds > 120) {
      return { state: "invalid" };
    }
    const manifest = this._manifest(noteId);
    if (!manifest) return { state: "unavailable" };
    if (manifest.status === "deleted" || manifest.status === "expired" || manifest.status === "evicted") return { state: manifest.status };
    const state = manifest.tracks?.[track];
    if (!state?.chunks?.length) return { state: manifest.status === "recording" ? "not_flushed" : "unavailable" };
    const start = Math.max(0, Math.round(startSeconds * RATE));
    const requestedEnd = Math.round(endSeconds * RATE);
    const end = Math.min(requestedEnd, state.sampleCount);
    if (end <= start) return { state: manifest.status === "recording" ? "not_flushed" : "unavailable" };
    const parts = [];
    let covered = 0;
    let lastEnd = null;
    for (const chunk of state.chunks) {
      const chunkEnd = chunk.startSample + chunk.sampleCount;
      if (chunkEnd <= start || chunk.startSample >= end) continue;
      let decoded;
      let plaintext;
      try { plaintext = this.encryption.decryptBytes(fs.readFileSync(path.join(this._dir(noteId), chunk.file))); }
      catch { return { state: "key_unavailable" }; }
      try { decoded = decode(unpack(plaintext).ogg); }
      catch { return { state: "unavailable" }; }
      const from = Math.max(start, chunk.startSample) - chunk.startSample;
      const to = Math.min(end, chunkEnd) - chunk.startSample;
      if (lastEnd != null && chunk.startSample + from > lastEnd) return { state: "unavailable" };
      const part = decoded.subarray(from * 2, Math.min(to * 2, decoded.length));
      parts.push(part);
      covered += part.length / 2;
      lastEnd = chunk.startSample + to;
    }
    if (!parts.length) return { state: "unavailable" };
    const pcm = Buffer.concat(parts);
    return { state: "available", wav: wav(pcm), durationSeconds: pcm.length / (RATE * 2),
      partial: end < requestedEnd || covered < requestedEnd - start, codec: "audio/wav" };
  }

  delete(noteId, reason = "deleted") {
    this._noteId(noteId);
    if (!["deleted", "expired", "evicted"].includes(reason)) throw new Error("Invalid deletion reason");
    const manifest = this._manifest(noteId);
    if (!manifest) return { state: "unavailable", freedBytes: 0 };
    this.active.delete(noteId);
    let freedBytes = 0;
    for (const track of TRACKS) {
      for (const chunk of manifest.tracks?.[track]?.chunks || []) {
        const file = path.join(this._dir(noteId), chunk.file);
        try { freedBytes += fs.statSync(file).size; fs.unlinkSync(file); } catch {}
      }
      if (manifest.tracks?.[track]) {
        manifest.tracks[track].chunks = [];
        manifest.tracks[track].byteLength = 0;
      }
    }
    manifest.status = reason;
    manifest.reason = reason;
    writeJsonAtomic(this._manifestPath(noteId), manifest);
    this._removeDerivedVoice(noteId);
    if (reason === "evicted") {
      const title = this.database?.getNote?.(noteId)?.title || `#${noteId}`;
      this.evictions = [{ noteId, title, at: this.now() }, ...this.evictions].slice(0, 20);
      writeJsonAtomic(this.noticeFile, this.evictions);
      this.onEvicted?.({ noteId, title });
    }
    return { state: reason, freedBytes };
  }

  purge(noteId) {
    this.delete(noteId);
    fs.rmSync(this._dir(noteId), { recursive: true, force: true });
  }

  _removeDerivedVoice(noteId) {
    const db = this.database?.db;
    if (!db) return;
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='voice_exemplars'").get();
    if (!table) return;
    db.transaction(() => {
      const affected = db.prepare("SELECT DISTINCT profile_id FROM voice_exemplars WHERE note_id = ?").all(noteId);
      db.prepare("DELETE FROM voice_exemplars WHERE note_id = ?").run(noteId);
      db.prepare("DELETE FROM voice_enrollment_candidates WHERE note_id = ?").run(noteId);
      db.prepare("DELETE FROM note_speaker_embeddings WHERE note_id = ?").run(noteId);
      for (const { profile_id } of affected) {
        db.prepare("UPDATE speaker_profiles SET embedding = ?, sample_count = 0, voice_needs_reapproval = 1 WHERE id = ?")
          .run(Buffer.alloc(0), profile_id);
      }
    })();
  }

  setPolicy({ days, budgetBytes }) {
    if (![3, 7, 30].includes(days) || !Number.isSafeInteger(budgetBytes) || budgetBytes < 1024 * 1024) {
      throw new Error("Invalid audio retention policy");
    }
    this.policy = { days, budgetBytes };
    writeJsonAtomic(this.policyFile, this.policy);
    for (const name of fs.readdirSync(this.root).filter((item) => /^\d+$/.test(item))) {
      const noteId = Number(name);
      const manifest = this._manifest(noteId);
      if (manifest && ["recording", "complete", "incomplete"].includes(manifest.status)) {
        manifest.retentionDays = days;
        const active = this.active.get(noteId);
        if (active) active.manifest.retentionDays = days;
        writeJsonAtomic(this._manifestPath(noteId), manifest);
      }
    }
    return this.enforce();
  }

  setKeep(noteId, keep) {
    this._noteId(noteId);
    const manifest = this._manifest(noteId);
    if (!manifest || !["recording", "complete", "incomplete"].includes(manifest.status)) return { state: "unavailable" };
    manifest.keep = keep === true;
    const active = this.active.get(noteId);
    if (active) active.manifest.keep = manifest.keep;
    writeJsonAtomic(this._manifestPath(noteId), manifest);
    return this.status(noteId);
  }

  usage() {
    let usedBytes = 0;
    for (const name of fs.readdirSync(this.root)) {
      if (!/^\d+$/.test(name)) continue;
      usedBytes += this.status(Number(name)).bytes;
    }
    return { usedBytes, budgetBytes: this.policy.budgetBytes, days: this.policy.days,
      evictions: this.evictions };
  }

  enforce(incomingBytes = 0) {
    const now = this.now();
    const candidates = [];
    const removed = [];
    for (const name of fs.readdirSync(this.root)) {
      if (!/^\d+$/.test(name)) continue;
      const noteId = Number(name);
      const manifest = this._manifest(noteId);
      if (!manifest || !["complete", "incomplete"].includes(manifest.status)) continue;
      if (!manifest.keep && now >= manifest.startedAt + manifest.retentionDays * 86400000) {
        removed.push({ noteId, reason: "expired", ...this.delete(noteId, "expired") });
      } else candidates.push(manifest);
    }
    let { usedBytes } = this.usage();
    for (const manifest of candidates.sort((a, b) => a.startedAt - b.startedAt)) {
      if (usedBytes + incomingBytes <= this.policy.budgetBytes) break;
      if (this.active.has(manifest.noteId)) continue;
      const result = this.delete(manifest.noteId, "evicted");
      usedBytes -= result.freedBytes;
      removed.push({ noteId: manifest.noteId, reason: "evicted", ...result });
    }
    return { ...this.usage(), removed };
  }
}

module.exports = { MeetingAudioStore, RATE, CHUNK_SAMPLES };
