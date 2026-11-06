const fs = require("fs");
const path = require("path");
const { randomUUID, createHash } = require("crypto");
const { spawnSync, execFile } = require("child_process");
const { getFFmpegPath } = require("./ffmpegUtils");
const { encryptBytes, decryptBytes, refreshAudioKey } = require("./secretCrypto");
const enrollmentTiming = require("./voiceEnrollmentTiming");
const { exactCoverage, durationMatches } = require("./voiceAudioIntegrity");

const RATE = 24000;
const CHUNK_SAMPLES = RATE * 5;
const DEFAULT_BUDGET = 2 * 1024 * 1024 * 1024;
const TRACKS = ["mic", "system"];
const CODEC_TIMEOUT_MS = 5000;

function statIfPresent(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function audioFailure(error) {
  if (error.code === "audio_corrupt") return { state: "corrupt", reason: "audio_corrupt" };
  if (error.code === "ENOENT") return { state: "unavailable", reason: "audio_missing" };
  if (error.code === "ETIMEDOUT" || error.killed)
    return { state: "temporary_failure", reason: "decoder_timeout" };
  return { state: "temporary_failure", reason: error.code || "audio_io_error" };
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${randomUUID()}.pending`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function encode(pcm) {
  const result = spawnSync(
    getFFmpegPath(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "s16le",
      "-ar",
      String(RATE),
      "-ac",
      "1",
      "-i",
      "pipe:0",
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      "-application",
      "audio",
      "-f",
      "ogg",
      "pipe:1",
    ],
    {
      input: pcm,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      timeout: CODEC_TIMEOUT_MS,
      killSignal: "SIGKILL",
    }
  );
  if (result.status !== 0 || !result.stdout?.length) {
    throw new Error(
      `Audio encoding failed: ${String(result.stderr || result.error || "unknown error")}`
    );
  }
  return result.stdout;
}

function decodeArgs() {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "ogg",
    "-i",
    "pipe:0",
    "-f",
    "s16le",
    "-ar",
    String(RATE),
    "-ac",
    "1",
    "pipe:1",
  ];
}

function decode(ogg) {
  const result = spawnSync(getFFmpegPath(), decodeArgs(), {
    input: ogg,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    timeout: CODEC_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw Object.assign(new Error("Stored audio could not be decoded"), { code: "decoder_error" });
  return result.stdout;
}

function decodeAsync(ogg, { signal, timeout = CODEC_TIMEOUT_MS } = {}) {
  timeout = Math.max(1, Math.min(CODEC_TIMEOUT_MS, Math.floor(timeout) || CODEC_TIMEOUT_MS));
  return new Promise((resolve, reject) => {
    const child = execFile(
      getFFmpegPath(),
      decodeArgs(),
      {
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        timeout,
        killSignal: "SIGKILL",
        signal,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
    child.stdin.on("error", () => {}); // Early exit is reported by execFile's callback.
    child.stdin.end(ogg);
  });
}

const defaultCodec = { encode, decode, decodeAsync };

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
  if (length < 2 || length > 4096 || 4 + length > bytes.length)
    throw new Error("Invalid audio chunk header");
  return {
    entry: JSON.parse(bytes.subarray(4, 4 + length).toString("utf8")),
    ogg: bytes.subarray(4 + length),
  };
}

class MeetingAudioStore {
  constructor(
    root,
    {
      database = null,
      now = Date.now,
      encryption = { encryptBytes, decryptBytes, refreshAudioKey },
      codec = defaultCodec,
      onEvicted = null,
      onChanged = null,
      recovery = {},
    } = {}
  ) {
    this.root = root;
    this.database = database;
    this.now = now;
    this.encryption = encryption;
    this.codec = codec;
    this.onEvicted = onEvicted;
    this.onChanged = onChanged;
    this.active = new Map();
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(root).isDirectory()) throw new Error("Unsafe meeting audio root");
    this.policyFile = path.join(root, "policy.json");
    this.policy = this._readJson(this.policyFile) || { days: 3, budgetBytes: DEFAULT_BUDGET };
    this.noticeFile = path.join(root, "evictions.json");
    this.evictions = this._readJson(this.noticeFile) || [];
    this.repair();
    // Queue work without decoding during construction. Retention consults the
    // queue's database predicate, including sources not yet loaded into a page.
    this.legacyRecovery =
      this.database?.db
        ?.prepare("SELECT 1 FROM sqlite_master WHERE name = 'voice_evidence_provenance'")
        .get() && require("./voiceEnrollment").recoverLegacy(this.database, this, recovery);
    this.enforce();
  }

  cancelRecovery() {
    this.legacyRecovery?.cancel();
  }

  _readJson(file, strictIO = false) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if (strictIO && error.code && error.code !== "ENOENT") throw error;
      return null;
    }
  }

  _dir(noteId) {
    this._noteId(noteId);
    const dir = path.join(this.root, String(noteId));
    if (fs.existsSync(dir) && !fs.lstatSync(dir).isDirectory())
      throw new Error("Unsafe meeting audio directory");
    return dir;
  }
  _manifestPath(noteId) {
    return path.join(this._dir(noteId), "manifest.json");
  }
  _noteIdentity(noteId) {
    const db = this.database?.db;
    if (
      !db ||
      !db
        .prepare("PRAGMA table_info(notes)")
        .all()
        .some((column) => column.name === "client_note_id")
    )
      return null;
    return (
      db.prepare("SELECT client_note_id FROM notes WHERE id = ?").get(noteId)?.client_note_id ||
      null
    );
  }
  _manifest(noteId, strictIO = false) {
    this._noteId(noteId);
    const file = this._manifestPath(noteId);
    if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) return null;
    const manifest = this._readJson(file, strictIO);
    if (!manifest || manifest.noteId !== noteId) return null;
    const identity = this._noteIdentity(noteId);
    if (identity && manifest.noteIdentity !== identity) return null;
    if (
      !["recording", "complete", "incomplete", "deleted", "expired", "evicted"].includes(
        manifest.status
      )
    )
      return null;
    try {
      for (const track of TRACKS) {
        const chunks = manifest.tracks?.[track]?.chunks;
        if (manifest.tracks?.[track] && !Array.isArray(chunks)) return null;
        for (const chunk of chunks || []) this._chunkFile(noteId, chunk.file);
      }
    } catch (error) {
      if (strictIO && error.code && error.code !== "ENOENT") throw error;
      return null;
    }
    return manifest;
  }
  _chunkFile(noteId, name) {
    if (
      typeof name !== "string" ||
      !/^(mic|system)-\d{7}\.owac$/.test(name) ||
      path.basename(name) !== name
    )
      throw new Error("Invalid audio chunk name");
    const dir = this._dir(noteId);
    const file = path.resolve(dir, name);
    if (
      path.dirname(file) !== path.resolve(dir) ||
      (fs.existsSync(file) && !fs.lstatSync(file).isFile())
    )
      throw new Error("Unsafe audio chunk path");
    return file;
  }
  _ownedChunks(noteId) {
    const dir = this._dir(noteId);
    if (!fs.existsSync(dir)) return [];
    if (!fs.lstatSync(dir).isDirectory()) throw new Error("Unsafe meeting audio directory");
    return fs
      .readdirSync(dir)
      .filter((name) => /^(mic|system)-\d{7}\.owac$/.test(name))
      .map((name) => {
        const file = path.resolve(dir, name);
        if (path.dirname(file) !== path.resolve(dir)) throw new Error("Unsafe audio chunk path");
        return file;
      });
  }
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
    if (manifest && ["deleted", "expired", "evicted"].includes(manifest.status))
      throw new Error("Meeting audio was deleted");
    if (!manifest && fs.existsSync(this._manifestPath(noteId))) {
      // A stale or mismatched recording must not attach to a reused note ID.
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const prior = manifest && TRACKS.flatMap((track) => manifest.tracks?.[track]?.chunks || [])[0];
    if (prior) {
      try {
        this.encryption.decryptBytes(fs.readFileSync(this._chunkFile(noteId, prior.file)));
      } catch {
        throw new Error("Audio encryption key is unavailable for this meeting");
      }
    }
    if (
      !manifest ||
      !manifest.tracks?.mic ||
      !manifest.tracks?.system ||
      !["recording", "complete", "incomplete"].includes(manifest.status)
    ) {
      manifest = {
        version: 1,
        noteId,
        noteIdentity: this._noteIdentity(noteId),
        recordingId: randomUUID(),
        startedAt,
        status: "recording",
        retentionDays: this.policy.days,
        keep: false,
        reason: null,
        tracks: Object.fromEntries(
          TRACKS.map((track) => [
            track,
            {
              startedAt,
              sampleRate: RATE,
              codec: "ogg/opus",
              byteLength: 0,
              sampleCount: 0,
              chunks: [],
            },
          ])
        ),
      };
      writeJsonAtomic(this._manifestPath(noteId), manifest);
    } else {
      manifest.status = "recording";
      manifest.reason = null;
      writeJsonAtomic(this._manifestPath(noteId), manifest);
    }
    this.active.set(noteId, {
      manifest,
      pending: { mic: Buffer.alloc(0), system: Buffer.alloc(0) },
      firstChunk: { mic: true, system: true },
    });
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
      const cursor = Math.max(
        state.sampleCount,
        Math.round((Math.max(0, capturedAt - session.manifest.startedAt) * RATE) / 1000)
      );
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
    const payload = this.encryption.encryptBytes(packet(entry, this.codec.encode(pcm)));
    entry.byteLength = payload.length;
    const budget = this.enforce(payload.length);
    if (budget.usedBytes + payload.length > budget.budgetBytes) {
      throw new Error("Meeting audio disk budget is full");
    }
    // The authenticated chunk is durable before its index entry. Repair can
    // recover a chunk if the process dies before the manifest rename.
    const chunkFile = this._chunkFile(noteId, filename);
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
    for (const track of TRACKS) session?.pending[track]?.fill(0);
    this.active.delete(noteId);
    const raw = this._readJson(this._manifestPath(noteId));
    if (["deleted", "expired", "evicted"].includes(raw?.status)) return;
    if (!manifest) {
      this._noteId(noteId);
      fs.mkdirSync(this._dir(noteId), { recursive: true, mode: 0o700 });
      manifest = {
        version: 1,
        noteId,
        noteIdentity: this._noteIdentity(noteId),
        startedAt: this.now(),
        retentionDays: this.policy.days,
        keep: false,
        tracks: {},
      };
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
      if (
        !manifest ||
        manifest.version !== 1 ||
        ["deleted", "expired", "evicted"].includes(manifest.status)
      )
        continue;
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
        for (const fileName of fs
          .readdirSync(this._dir(noteId))
          .filter((file) => new RegExp(`^${track}-\\d{7}\\.owac$`).test(file))
          .sort()) {
          let file;
          try {
            file = this._chunkFile(noteId, fileName);
            const bytes = fs.readFileSync(file);
            const { entry } = unpack(this.encryption.decryptBytes(bytes));
            if (
              entry.file !== fileName ||
              !Number.isSafeInteger(entry.startSample) ||
              !Number.isSafeInteger(entry.sampleCount) ||
              entry.sampleCount <= 0
            )
              throw new Error("Bad audio index");
            entries.push({ ...entry, byteLength: bytes.length });
            sampleCount = Math.max(sampleCount, entry.startSample + entry.sampleCount);
            byteLength += bytes.length;
          } catch {
            // Preserve an indexed ciphertext chunk if its key is temporarily
            // unavailable; continue recovering independent chunks and meetings.
            const prior = state.chunks.find((chunk) => chunk.file === fileName);
            if (
              prior &&
              Number.isSafeInteger(prior.startSample) &&
              Number.isSafeInteger(prior.sampleCount) &&
              prior.sampleCount > 0
            ) {
              entries.push(prior);
              sampleCount = Math.max(sampleCount, prior.startSample + prior.sampleCount);
              byteLength += prior.byteLength || (file ? fs.lstatSync(file).size : 0);
            }
            continue;
          }
        }
        if (
          entries.length !== state.chunks.length ||
          entries.some((entry, index) => entry.file !== state.chunks[index]?.file)
        )
          changed = true;
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
      state: manifest.status,
      reason: manifest.reason,
      bytes: TRACKS.reduce((sum, track) => sum + (manifest.tracks?.[track]?.byteLength || 0), 0),
      tracks: manifest.tracks,
      startedAt: manifest.startedAt,
      recordingId: manifest.recordingId ?? null,
      keep: manifest.keep,
    };
    if (
      !manifest.keep &&
      ["complete", "incomplete"].includes(manifest.status) &&
      this.now() >= manifest.startedAt + manifest.retentionDays * 86400000 &&
      !this.legacyRecovery?.protects(noteId)
    ) {
      result.state = "expired";
      result.bytes = 0;
      return result;
    }
    const first = TRACKS.flatMap((track) => manifest.tracks?.[track]?.chunks || [])[0];
    if (first) {
      let file;
      try {
        file = this._chunkFile(noteId, first.file);
      } catch {
        result.state = "unavailable";
        result.reason = "Invalid stored audio chunk";
        return result;
      }
      if (!fs.existsSync(file)) {
        result.state = "unavailable";
        result.reason = "Stored audio chunk is missing";
      } else {
        try {
          this.encryption.decryptBytes(fs.readFileSync(file));
        } catch (error) {
          result.state = error.code === "audio_corrupt" ? "corrupt" : "key_unavailable";
          result.reason =
            error.code === "audio_corrupt"
              ? "Audio authentication failed"
              : "Audio encryption key is unavailable";
        }
      }
    }
    return result;
  }

  recordingProvenance(noteId, sample = null) {
    const manifest = this._manifest(noteId, true);
    if (!manifest || !["complete", "incomplete"].includes(manifest.status)) return null;
    const chunks = TRACKS.flatMap((track) => manifest.tracks?.[track]?.chunks || []);
    const indexed = chunks.some((chunk) =>
      statIfPresent(this._chunkFile(noteId, chunk.file))?.isFile()
    );
    if (!indexed && !this._ownedChunks(noteId).length) return null;
    if (sample) {
      // Diagnostic snapshot only: repair, re-encryption and chunking may change
      // this hash while the decoded approved PCM stays identical.
      const hash = createHash("sha256");
      hash.update(
        JSON.stringify([manifest.noteId, manifest.noteIdentity, manifest.recordingId, sample.track])
      );
      for (const chunk of manifest.tracks?.[sample.track]?.chunks || []) {
        if (
          chunk.startSample >= sample.end_sample ||
          chunk.startSample + chunk.sampleCount <= sample.start_sample
        )
          continue;
        hash.update(JSON.stringify(chunk));
        hash.update(fs.readFileSync(this._chunkFile(noteId, chunk.file)));
      }
      return { ...manifest, hasSourceAudio: true, contentHash: hash.digest("hex") };
    }
    return { ...manifest, hasSourceAudio: true };
  }

  // Cheap listing check: validate the retained chunk coverage without decoding
  // every candidate in a long meeting. Playback rechecks and decodes the span.
  spanAvailable(noteId, track, startSample, endSample) {
    const manifest = this._manifest(noteId);
    if (!manifest || !["complete", "incomplete"].includes(manifest.status)) return false;
    const state = manifest.tracks?.[track];
    if (!state || endSample > state.sampleCount || startSample < 0) return false;
    if (!exactCoverage(state.chunks || [], startSample, endSample)) return false;
    for (const chunk of state.chunks || []) {
      const chunkEnd = chunk.startSample + chunk.sampleCount;
      if (chunkEnd <= startSample || chunk.startSample >= endSample) continue;
      try {
        if (!fs.existsSync(this._chunkFile(noteId, chunk.file))) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  span(noteId, track, startSeconds, endSeconds) {
    const start = enrollmentTiming.now();
    const metrics = enrollmentTiming.current?.();
    const beforeDecode = metrics?.ffmpeg_decode_ms || 0;
    try {
      return this._span(noteId, track, startSeconds, endSeconds);
    } finally {
      const decoded = (metrics?.ffmpeg_decode_ms || 0) - beforeDecode;
      enrollmentTiming.span(Math.max(0, enrollmentTiming.now() - start - decoded));
    }
  }

  _span(noteId, track, startSeconds, endSeconds) {
    const steps = this._spanSteps(noteId, track, startSeconds, endSeconds);
    let step = steps.next();
    while (!step.done) {
      try {
        step = steps.next(this.codec.decode(step.value));
      } catch (error) {
        step = steps.throw(error);
      }
    }
    return step.value;
  }

  async spanAsync(noteId, track, startSeconds, endSeconds, options = {}) {
    const steps = this._spanSteps(noteId, track, startSeconds, endSeconds);
    let step = steps.next();
    while (!step.done) {
      try {
        options.signal?.throwIfAborted();
        const decoded = await (this.codec.decodeAsync?.(step.value, options) ??
          this.codec.decode(step.value));
        step = steps.next(decoded);
      } catch (error) {
        step = steps.throw(error);
      }
    }
    return step.value;
  }

  *_spanSteps(noteId, track, startSeconds, endSeconds) {
    this._noteId(noteId);
    if (
      !TRACKS.includes(track) ||
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      startSeconds < 0 ||
      endSeconds <= startSeconds ||
      endSeconds - startSeconds > 120
    ) {
      return { state: "invalid" };
    }
    const manifest = this._manifest(noteId, true);
    if (!manifest) return { state: "unavailable" };
    if (
      manifest.status === "deleted" ||
      manifest.status === "expired" ||
      manifest.status === "evicted"
    )
      return { state: manifest.status };
    const state = manifest.tracks?.[track];
    if (!state?.chunks?.length) {
      // A locked key can leave every durable chunk unindexed. Probe an owned
      // orphan so key refresh remains possible; absence of an index is not loss.
      const orphan = this._ownedChunks(noteId).find((file) =>
        path.basename(file).startsWith(`${track}-`)
      );
      if (orphan) {
        try {
          this.encryption.decryptBytes(fs.readFileSync(orphan));
        } catch (error) {
          return error.code === "audio_key_unavailable" || !error.code
            ? { state: "key_unavailable", reason: "audio_key_unavailable" }
            : audioFailure(error);
        }
        return { state: "temporary_failure", reason: "audio_index_incomplete" };
      }
      return { state: manifest.status === "recording" ? "not_flushed" : "unavailable" };
    }
    const start = Math.max(0, Math.round(startSeconds * RATE));
    const requestedEnd = Math.round(endSeconds * RATE);
    const end = Math.min(requestedEnd, state.sampleCount);
    if (end <= start)
      return { state: manifest.status === "recording" ? "not_flushed" : "unavailable" };
    // A pause deliberately leaves an interval without chunks. Refuse playback
    // as a gap before checking for unexpected missing or overlapping coverage.
    if (state.gaps?.some((gap) => gap.startSample < requestedEnd && gap.endSample > start))
      return { state: "gap" };
    const integrityFailure = { state: "temporary_failure", reason: "source_integrity_failed" };
    if (!exactCoverage(state.chunks, start, requestedEnd)) return integrityFailure;
    // Authenticate every selected interval before yielding even the first
    // decoder input. A later duplicate must never be hidden by an early break.
    const authenticated = [];
    let bytesRead = 0;
    for (const chunk of state.chunks) {
      const chunkEnd = chunk.startSample + chunk.sampleCount;
      if (chunkEnd <= start || chunk.startSample >= end) continue;
      let plaintext;
      try {
        const encrypted = fs.readFileSync(this._chunkFile(noteId, chunk.file));
        bytesRead += encrypted.length;
        try {
          plaintext = this.encryption.decryptBytes(encrypted);
        } catch (error) {
          return error.code && error.code !== "audio_key_unavailable"
            ? audioFailure(error)
            : { state: "key_unavailable", reason: "audio_key_unavailable" };
        }
      } catch (error) {
        return audioFailure(error);
      }
      try {
        const { entry, ogg } = unpack(plaintext);
        if (
          entry.file !== chunk.file ||
          entry.startSample !== chunk.startSample ||
          entry.sampleCount !== chunk.sampleCount
        )
          return integrityFailure;
        authenticated.push({ ...entry, ogg });
      } catch {
        return { state: "corrupt", reason: "audio_corrupt" };
      }
    }
    if (!exactCoverage(authenticated, start, requestedEnd)) return integrityFailure;
    authenticated.sort((a, b) => a.startSample - b.startSample);
    const parts = [];
    let covered = 0;
    for (const chunk of authenticated) {
      let decoded;
      try {
        const decodeStart = enrollmentTiming.now();
        try {
          decoded = yield chunk.ogg;
        } finally {
          enrollmentTiming.decoded(enrollmentTiming.now() - decodeStart);
        }
      } catch (error) {
        return {
          state: "temporary_failure",
          reason: error.code === "ETIMEDOUT" || error.killed ? "decoder_timeout" : "decoder_error",
        };
      }
      if (!durationMatches(decoded.length / 48, chunk.sampleCount) || decoded.length % 2)
        return integrityFailure;
      const chunkEnd = chunk.startSample + chunk.sampleCount;
      const from = Math.max(start, chunk.startSample) - chunk.startSample;
      const to = Math.min(end, chunkEnd) - chunk.startSample;
      const part = decoded.subarray(from * 2, Math.min(to * 2, decoded.length));
      parts.push(part);
      covered += part.length / 2;
    }
    if (!parts.length) return { state: "unavailable" };
    const pcm = Buffer.concat(parts);
    if (!durationMatches(pcm.length / 48, requestedEnd - start)) return integrityFailure;
    return {
      state: "available",
      wav: wav(pcm),
      bytesRead,
      durationSeconds: pcm.length / (RATE * 2),
      partial: end < requestedEnd || covered < requestedEnd - start,
      codec: "audio/wav",
    };
  }

  // Explicit owner export. Decode one encrypted chunk at a time; do not retain
  // a second whole-meeting PCM buffer or change the retained recording.
  exportTrack(noteId, track, destination) {
    this._noteId(noteId);
    if (!TRACKS.includes(track)) throw Error("Invalid audio track");
    const chunks = this._manifest(noteId)?.tracks?.[track]?.chunks;
    if (!chunks?.length) return false;
    const fd = fs.openSync(destination, "wx", 0o600);
    try {
      fs.writeSync(fd, wav(Buffer.alloc(0)).subarray(0, 44));
      let samples = 0;
      const silence = Buffer.alloc(RATE * 2);
      for (const chunk of chunks) {
        if (chunk.startSample < samples) throw Error("Stored audio chunks overlap");
        while (samples < chunk.startSample) {
          const count = Math.min(RATE, chunk.startSample - samples);
          fs.writeSync(fd, silence.subarray(0, count * 2));
          samples += count;
        }
        const pcm = this.codec.decode(
          unpack(this.encryption.decryptBytes(fs.readFileSync(this._chunkFile(noteId, chunk.file))))
            .ogg
        );
        if (pcm.length !== chunk.sampleCount * 2) throw Error("Stored audio chunk length changed");
        fs.writeSync(fd, pcm);
        samples += chunk.sampleCount;
      }
      const bytes = samples * 2;
      const header = wav(Buffer.alloc(0)).subarray(0, 44);
      header.writeUInt32LE(bytes + 36, 4);
      header.writeUInt32LE(bytes, 40);
      fs.writeSync(fd, header, 0, 44, 0);
      return samples / RATE;
    } catch (error) {
      fs.closeSync(fd);
      fs.rmSync(destination, { force: true });
      throw error;
    } finally {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }

  delete(noteId, reason = "deleted") {
    this._noteId(noteId);
    if (!["deleted", "expired", "evicted"].includes(reason))
      throw new Error("Invalid deletion reason");
    const manifest = this._manifest(noteId);
    if (!manifest && !fs.existsSync(this._dir(noteId)))
      return { state: "unavailable", freedBytes: 0 };
    const active = this.active.get(noteId);
    for (const track of TRACKS) active?.pending[track]?.fill(0);
    this.active.delete(noteId);
    let freedBytes = 0;
    // Remove all owned chunks, including a durable write not yet indexed.
    for (const file of this._ownedChunks(noteId)) {
      const size = fs.lstatSync(file).size;
      fs.unlinkSync(file);
      freedBytes += size;
    }
    const tombstone = manifest || {
      version: 1,
      noteId,
      noteIdentity: this._noteIdentity(noteId),
      tracks: {},
    };
    for (const track of TRACKS) {
      if (tombstone.tracks?.[track]) {
        tombstone.tracks[track].chunks = [];
        tombstone.tracks[track].byteLength = 0;
      }
    }
    tombstone.status = reason;
    tombstone.reason = reason;
    writeJsonAtomic(this._manifestPath(noteId), tombstone);
    this.onChanged?.({ noteId, state: reason });
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

  purgeAll() {
    const noteIds = fs.existsSync(this.root)
      ? fs
          .readdirSync(this.root)
          .filter((name) => /^\d+$/.test(name))
          .map(Number)
      : [];
    for (const session of this.active.values())
      for (const track of TRACKS) session.pending[track]?.fill(0);
    this.active.clear();
    fs.rmSync(this.root, { recursive: true, force: true });
    if (
      this.database?.db
        ?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_row_cache'")
        .get()
    )
      this.database.db.prepare("DELETE FROM review_row_cache").run();
    if (
      this.database?.db
        ?.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='voice_enrollment_fact_cache'"
        )
        .get()
    )
      this.database.db.prepare("DELETE FROM voice_enrollment_fact_cache").run();
    for (const noteId of noteIds) this.onChanged?.({ noteId, state: "deleted" });
  }

  _removeDerivedVoice(noteId) {
    const db = this.database?.db;
    if (!db) return;
    if (
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_row_cache'").get()
    )
      db.prepare("DELETE FROM review_row_cache WHERE note_id = ?").run(noteId);
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='voice_enrollment_fact_cache'"
        )
        .get()
    )
      db.prepare("DELETE FROM voice_enrollment_fact_cache WHERE note_id = ?").run(noteId);
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='voice_exemplars'")
      .get();
    if (!table) return;
    db.transaction(() => {
      const hasEnrollmentSchema = db
        .prepare("PRAGMA table_info(voice_exemplars)")
        .all()
        .some((column) => column.name === "row_ids");
      if (hasEnrollmentSchema) require("./voiceEnrollment").removeNoteEvidence(db, noteId);
      else {
        // Older installations and small retention fixtures have the original
        // exemplar table but no consent/action columns yet.
        const affected = db
          .prepare("SELECT DISTINCT profile_id FROM voice_exemplars WHERE note_id = ?")
          .all(noteId);
        db.prepare("DELETE FROM voice_exemplars WHERE note_id = ?").run(noteId);
        db.prepare("DELETE FROM voice_enrollment_candidates WHERE note_id = ?").run(noteId);
        for (const { profile_id } of affected)
          db.prepare(
            `UPDATE speaker_profiles
          SET embedding = x'', sample_count = 0, voice_needs_reapproval = 1 WHERE id = ?`
          ).run(profile_id);
      }
      db.prepare("DELETE FROM note_speaker_embeddings WHERE note_id = ?").run(noteId);
    })();
  }

  setPolicy({ days, budgetBytes }) {
    if (
      ![3, 7, 30].includes(days) ||
      !Number.isSafeInteger(budgetBytes) ||
      budgetBytes < 1024 * 1024
    ) {
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
    if (!manifest || !["recording", "complete", "incomplete"].includes(manifest.status))
      return { state: "unavailable" };
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
    const hasExemplars = this.database?.db
      ?.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'voice_exemplar_audio'"
      )
      .get();
    const permanent = hasExemplars
      ? this.database.db
          .prepare(
            "SELECT COALESCE(SUM(length(ciphertext)), 0) AS bytes, COUNT(*) AS clips FROM voice_exemplar_audio"
          )
          .get()
      : { bytes: 0, clips: 0 };
    return {
      usedBytes,
      permanentAudioBytes: permanent.bytes,
      permanentAudioCount: permanent.clips,
      budgetBytes: this.policy.budgetBytes,
      days: this.policy.days,
      evictions: this.evictions,
    };
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
      if (this.legacyRecovery?.protects(noteId)) continue;
      if (!manifest.keep && now >= manifest.startedAt + manifest.retentionDays * 86400000) {
        removed.push({ noteId, reason: "expired", ...this.delete(noteId, "expired") });
      } else candidates.push(manifest);
    }
    let { usedBytes } = this.usage();
    for (const manifest of candidates.sort((a, b) => a.startedAt - b.startedAt)) {
      if (usedBytes + incomingBytes <= this.policy.budgetBytes) break;
      if (this.active.has(manifest.noteId)) continue;
      const result = this.delete(this._noteId(manifest.noteId), "evicted");
      usedBytes -= result.freedBytes;
      removed.push({ noteId: manifest.noteId, reason: "evicted", ...result });
    }
    return { ...this.usage(), removed };
  }
}

module.exports = { MeetingAudioStore, RATE, CHUNK_SAMPLES, defaultCodec, CODEC_TIMEOUT_MS };
