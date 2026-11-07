const createTempDir = require("../lib/tempDir");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
let directory;
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron")
    return {
      app: { getPath: () => directory, getAppPath: () => process.cwd(), isReady: () => false },
    };
  return load.call(this, request, parent, isMain);
};
process.env.NODE_ENV = "test";
const DatabaseManager = require("../../src/helpers/database");
const enrollment = require("../../src/helpers/voiceEnrollment");
const { MeetingAudioStore, RATE } = require("../../src/helpers/meetingAudioStore");
const codec = require("../lib/fakeAudioCodec");

function fixture(t, options = {}) {
  directory = createTempDir(path.join(os.tmpdir(), "exemplar-"));
  const root = directory;
  let database = new DatabaseManager();
  let clock = Date.now();
  const key = crypto.randomBytes(32);
  const encryption = {
    getWorkerKey: () => Buffer.from(key),
    encryptBytes(bytes) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
    },
    decryptBytes(bytes) {
      try {
        const cipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
        cipher.setAuthTag(bytes.subarray(-16));
        return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]);
      } catch (cause) {
        throw Object.assign(Error("authentication failed", { cause }), { code: "audio_corrupt" });
      }
    },
  };
  const makeStore = () =>
    new MeetingAudioStore(path.join(root, "recordings"), {
      database,
      encryption,
      codec,
      ...options,
      now: () => clock,
    });
  let store = makeStore();
  const person = database.createNamedSpeakerProfile("Alex");
  const note = database.saveNote("Evidence", "", "meeting");
  const noteId = (note.note || note).id;
  database.updateNote(noteId, {
    transcript: JSON.stringify({
      version: 2,
      rows: [
        {
          id: "approved-row",
          text: "Evidence",
          speaker: "speaker_0",
          source: "mic",
          speakerName: "Alex",
          speakerLockSource: "user",
          suggestedProfileId: person.id,
          audioSpan: { recordingId: noteId, trackId: "mic", startSample: 0, endSample: RATE * 4 },
        },
      ],
    }),
  });
  const pcm = Buffer.alloc(RATE * 2 * 5);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(Math.round(10000 * Math.sin(i / 24)), i * 2);
  store.begin(noteId);
  store.append(noteId, "mic", pcm);
  store.finish(noteId);
  const document = JSON.parse(database.getNote(noteId).transcript);
  document.rows[0].audioSpan.recordingId = store.status(noteId).recordingId;
  database.updateNote(noteId, { transcript: JSON.stringify(document) });
  const extractor = {
    extractEmbeddingFromSamples: async () =>
      Float32Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)),
  };
  t.after(() => {
    store.cancelRecovery?.();
    database.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    get database() {
      return database;
    },
    get store() {
      return store;
    },
    person,
    noteId,
    encryption,
    extractor,
    addMeeting() {
      const saved = database.saveNote("More evidence", "", "meeting");
      const id = (saved.note || saved).id;
      store.begin(id);
      store.append(id, "mic", pcm);
      store.finish(id);
      const row = {
        ...document.rows[0],
        id: `row-${id}`,
        audioSpan: { ...document.rows[0].audioSpan, recordingId: store.status(id).recordingId },
      };
      database.updateNote(id, { transcript: JSON.stringify({ version: 2, rows: [row] }) });
    },
    advance(days) {
      clock += days * 86400000;
    },
    restart() {
      store.cancelRecovery?.();
      database.db.close();
      database = new DatabaseManager();
      store = makeStore();
    },
    async approve() {
      const [candidate] = enrollment.listCandidates(database, store, person.id);
      const playback = enrollment.play(database, store, candidate.id);
      clock += 5000;
      assert.equal(
        enrollment.complete(database, store, candidate.id, playback.token).success,
        true
      );
      const result = await enrollment.decide(
        database,
        store,
        extractor,
        candidate.id,
        "approve",
        playback.token
      );
      assert.equal(result.success, true, result.error);
      return { candidate, playback };
    },
  };
}

async function legacyFixture(t, options = {}) {
  const f = fixture(t, options);
  const approved = await f.approve();
  f.database.db.exec("DELETE FROM voice_exemplar_audio; DELETE FROM voice_evidence_provenance");
  return { f, ...approved };
}

// Preserve the approval-time identity while simulating a lost durable clip.
async function waitForRecoveryFailure(f, t) {
  const deadline = Date.now() + 3000;
  while (!f.store.legacyRecovery.failures.length) {
    t.signal.throwIfAborted();
    assert.equal(f.store.legacyRecovery.recoveryFailed, 0, "recovery terminated before a retry");
    assert.ok(Date.now() < deadline, "recovery did not report its retry");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function sixthFixture(t, options = {}) {
  const f = fixture(t, { recovery: { retryBaseMs: 30, yieldMs: 1 }, ...options });
  const { candidate, playback } = await f.approve();
  f.advance(30); // Source retention is already overdue before recovery begins.
  f.database.db.exec(`DELETE FROM voice_exemplar_audio;
    UPDATE voice_evidence_provenance SET state='pending_recovery', recording_id=NULL`);
  f.restart();
  f.store.spanAsync = async () => ({ state: "temporary_failure", reason: "decoder_error" });
  await waitForRecoveryFailure(f, t);
  f.store.cancelRecovery();
  return { f, candidate, playback };
}

function rewriteChunks(f, transform, audioCodec = codec) {
  const dir = path.join(directory, "recordings", String(f.noteId));
  const manifest = f.store._manifest(f.noteId);
  const chunks = manifest.tracks.mic.chunks;
  const original = chunks.map((chunk) => {
    const bytes = f.encryption.decryptBytes(fs.readFileSync(path.join(dir, chunk.file)));
    const length = bytes.readUInt32LE(0);
    return audioCodec.decode(bytes.subarray(4 + length));
  });
  const parts = transform(Buffer.concat(original));
  for (const chunk of chunks) fs.unlinkSync(path.join(dir, chunk.file));
  let startSample = 0;
  manifest.tracks.mic.chunks = parts.map((pcm, index) => {
    const entry = {
      ...chunks[0],
      file: `mic-${String(index).padStart(7, "0")}.owac`,
      startSample,
      sampleCount: pcm.length / 2,
    };
    startSample += entry.sampleCount;
    const header = Buffer.from(JSON.stringify(entry));
    const size = Buffer.alloc(4);
    size.writeUInt32LE(header.length);
    // Alter the encoded representation too; fake codec ignores its padding.
    const packed = Buffer.concat([size, header, audioCodec.encode(pcm)]);
    const ciphertext = f.encryption.encryptBytes(packed);
    fs.writeFileSync(path.join(dir, entry.file), ciphertext);
    return { ...entry, byteLength: ciphertext.length };
  });
  manifest.tracks.mic.sampleCount = startSample;
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
}

function addOverlap(f, duplicate = false) {
  const dir = path.join(directory, "recordings", String(f.noteId));
  const manifest = f.store._manifest(f.noteId);
  const first = manifest.tracks.mic.chunks[0];
  const plaintext = f.encryption.decryptBytes(fs.readFileSync(path.join(dir, first.file)));
  const length = plaintext.readUInt32LE(0);
  const entry = {
    ...first,
    file: "mic-0000001.owac",
    startSample: duplicate ? first.startSample : RATE / 4,
  };
  const header = Buffer.from(JSON.stringify(entry));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(header.length);
  fs.writeFileSync(
    path.join(dir, entry.file),
    f.encryption.encryptBytes(Buffer.concat([size, header, plaintext.subarray(4 + length)]))
  );
  // Leave it unindexed: the real startup repair must discover the overlap.
  return path.join(dir, entry.file);
}

for (const duplicate of [false, true]) {
  test(`seventh run: ${duplicate ? "duplicate interval" : "overlap without encryption failure"}`, async (t) => {
    const { f, candidate } = await legacyFixture(t, { recovery: { retryBaseMs: 1, yieldMs: 1 } });
    addOverlap(f, duplicate);
    let decoded = 0;
    f.restart();
    f.store.codec = {
      ...codec,
      decode: (bytes) => {
        decoded++;
        return codec.decode(bytes);
      },
    };
    await f.store.legacyRecovery.done;
    const saved = f.database.db
      .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id=?")
      .get(candidate.id);
    assert.equal(saved.recovery_reason, "source_integrity_failed");
    assert.equal(saved.recovery_attempts, 3);
    assert.equal(decoded, 0);
    assert.equal(saved.recovery_pcm_hash, null);
    assert.equal(f.database.getVoiceExemplarAudio().length, 0);
    assert.equal(f.store.enforce().removed.length, 0);
    assert.equal(
      f.store.spanAvailable(f.noteId, "mic", candidate.startSample, candidate.endSample),
      false
    );
    t.diagnostic(
      `seventh ${duplicate ? "duplicate interval" : "overlap without encryption failure"}: reason=${saved.recovery_reason} attempts=${saved.recovery_attempts} decoded=${decoded} baseline=${saved.recovery_pcm_hash} clips=0 deletions=0`
    );
  });
}

test("seventh run: historical overlapping decode, pin, encryption failure, exact repair", async (t) => {
  const { f, candidate, playback } = await legacyFixture(t, {
    recovery: { retryBaseMs: 30, yieldMs: 1 },
  });
  const overlap = addOverlap(f);
  f.restart();
  f.store.cancelRecovery();
  const historical = require("../../artifacts/enrolment-audio-retention/seventh-legacy.cjs");
  const oldSpan = historical("meetingAudioStore").MeetingAudioStore.prototype._spanSteps;
  const currentSpan = f.store._spanSteps;
  f.store._spanSteps = oldSpan;
  const first = f.store.span(
    f.noteId,
    "mic",
    candidate.startSample / RATE,
    candidate.endSample / RATE
  );
  assert.equal(first.partial, false);
  assert.equal(first.durationSeconds, 7);
  const encrypt = f.encryption.encryptBytes;
  f.encryption.encryptBytes = () => {
    throw Error("temporary encryption failure");
  };
  f.store.legacyRecovery = historical("voiceEnrollmentRecovery").start(f.database, f.store, {
    retryBaseMs: 1000,
    yieldMs: 1,
  });
  await waitForRecoveryFailure(f, t);
  f.store.cancelRecovery();
  const bad = f.database.db
    .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id=?")
    .get(candidate.id);
  assert.equal(bad.recovery_duration_ms, 7000);
  assert.equal(bad.recovery_pcm_hash, historical("voiceRecordingIdentity").pcmIdentity(first.wav));
  assert.equal(bad.recovery_reason, "exemplar_key_unavailable");
  f.encryption.encryptBytes = encrypt;
  f.store._spanSteps = currentSpan;
  fs.unlinkSync(overlap);
  f.restart();
  await f.store.legacyRecovery.done;
  const saved = f.database.db
    .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id=?")
    .get(candidate.id);
  assert.equal(saved.recovery_pcm_trust, "corrected");
  assert.equal(saved.recovery_untrusted_pcm_hash, bad.recovery_pcm_hash);
  assert.equal(saved.recovery_untrusted_duration_ms, 7000);
  assert.equal(saved.recovery_duration_ms, 3500);
  assert.ok(saved.recovery_pcm_corrected_at);
  assert.equal(saved.recovery_reason, "source_repaired");
  assert.equal(f.store.legacyRecovery.recovered, 1);
  assert.deepEqual(enrollment.play(f.database, f.store, candidate.id).wav, playback.wav);
  assert.equal(
    f.store.legacyRecovery.failures.some((failure) => failure.reason === "audio_content_mismatch"),
    false
  );
  assert.equal(f.store.enforce().removed.length, 0);
  t.diagnostic(
    `seventh historical sequence: approved=3.5s first=7s partial=false pinned=true encryption=failed repairedPCMEqual=true trust=${saved.recovery_pcm_trust} reason=${saved.recovery_reason} recovered=1 audio_content_mismatch=false deletions=0`
  );
});

test("seventh run: pre-existing terminal bad baseline is untrusted before exact decode", async (t) => {
  const { f, candidate, playback } = await legacyFixture(t, {
    recovery: { retryBaseMs: 1, yieldMs: 1 },
  });
  const identity = require("../../src/helpers/voiceRecordingIdentity");
  identity.classifyEvidence(
    f.database.db,
    f.database.db.prepare("SELECT * FROM voice_exemplars WHERE id=?").get(candidate.id),
    { store: f.store, record: true }
  );
  f.database.db
    .prepare(
      `UPDATE voice_evidence_provenance SET state='recovery_failed', recording_id=NULL,
    reason='audio_content_mismatch', recovery_reason='audio_content_mismatch', recovery_state='recovery_failed',
    recovery_pcm_hash='bad historical hash', recovery_duration_ms=7000, recovery_sample_rate=24000,
    recovery_attempts=3, recovery_expires_at=? WHERE sample_id=?`
    )
    .run(Date.now() + 86400000, candidate.id);
  f.restart();
  const untrusted = f.database.db
    .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id=?")
    .get(candidate.id);
  assert.equal(untrusted.recovery_pcm_trust, "untrusted");
  assert.equal(untrusted.recovery_pcm_hash, null);
  await f.store.legacyRecovery.done;
  const saved = f.database.db
    .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id=?")
    .get(candidate.id);
  assert.equal(saved.recovery_pcm_trust, "corrected");
  assert.equal(saved.recovery_untrusted_pcm_hash, "bad historical hash");
  assert.equal(saved.recovery_pcm_hash, identity.pcmIdentity(playback.wav));
  assert.equal(saved.recovery_reason, "source_repaired");
  assert.equal(saved.recovery_expires_at, untrusted.recovery_expires_at);
  assert.deepEqual(enrollment.play(f.database, f.store, candidate.id).wav, playback.wav);
  f.restart();
  await f.store.legacyRecovery.done;
  assert.deepEqual(
    f.database.db
      .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id=?")
      .get(candidate.id),
    saved
  );
  t.diagnostic(
    "seventh pre-existing bad baseline: trustBeforeDecode=untrusted trustAfter=corrected oldHashRetained=true repinned=true reason=source_repaired recovered=1 deadlineUnchanged=true restartUnchanged=true"
  );
});

for (const deltaSeconds of [-0.1, 0.1]) {
  test(`seventh run: decoded span duration ${deltaSeconds} seconds is never pinned or saved`, async (t) => {
    const { f, candidate, playback } = await legacyFixture(t, {
      recovery: { retryBaseMs: 1, yieldMs: 1 },
    });
    f.restart();
    const bytes = Buffer.alloc(playback.wav.length + Math.round(deltaSeconds * RATE) * 2);
    playback.wav.copy(bytes);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.writeUInt32LE(bytes.length - 44, 40);
    f.store.spanAsync = async () => ({ state: "available", wav: bytes, partial: false });
    await f.store.legacyRecovery.done;
    const saved = f.database.db
      .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id=?")
      .get(candidate.id);
    assert.equal(saved.recovery_reason, "source_integrity_failed");
    assert.equal(saved.recovery_attempts, 3);
    assert.equal(saved.recovery_pcm_hash, null);
    assert.equal(f.database.getVoiceExemplarAudio().length, 0);
    const sample = f.database.db
      .prepare("SELECT * FROM voice_exemplars WHERE id=?")
      .get(candidate.id);
    assert.throws(
      () =>
        require("../../src/helpers/voiceRecordingIdentity").pinAudio(
          f.database.db,
          sample,
          f.store.recordingProvenance(f.noteId),
          bytes
        ),
      { code: "source_integrity_failed" }
    );
    assert.throws(
      () =>
        require("../../src/helpers/voiceExemplarAudio").save(
          f.database.db,
          candidate,
          bytes,
          Buffer.alloc(0),
          sample.embedding
        ),
      { code: "source_integrity_failed" }
    );
    assert.equal(f.store.enforce().removed.length, 0);
    t.diagnostic(
      `seventh duration ${deltaSeconds}s: reason=source_integrity_failed attempts=3 baseline=null clips=0 pinGuard=true saveGuard=true deletions=0`
    );
  });
}

for (const defect of [
  "gap",
  "authenticated index mismatch",
  "decoded chunk too short",
  "decoded chunk too long",
]) {
  test(`seventh run: ${defect} refuses source integrity`, async (t) => {
    const { f, candidate } = await legacyFixture(t, { recovery: { retryBaseMs: 1, yieldMs: 1 } });
    rewriteChunks(f, (pcm) => [pcm.subarray(0, RATE * 2), pcm.subarray(RATE * 2)]);
    f.restart();
    let decoded = 0;
    f.store.codec = {
      ...codec,
      decode: (bytes) => {
        decoded++;
        const pcm = codec.decode(bytes);
        return defect.endsWith("short")
          ? pcm.subarray(0, pcm.length - RATE)
          : defect.endsWith("long")
            ? Buffer.concat([pcm, Buffer.alloc(RATE)])
            : pcm;
      },
    };
    const dir = path.join(directory, "recordings", String(f.noteId));
    const manifest = f.store._manifest(f.noteId);
    if (defect === "gap") manifest.tracks.mic.chunks.splice(0, 1);
    if (defect === "authenticated index mismatch") {
      // An authenticated later packet disagrees with a plausible exact index.
      const entry = manifest.tracks.mic.chunks[1];
      const file = path.join(dir, entry.file);
      const packet = f.encryption.decryptBytes(fs.readFileSync(file));
      const length = packet.readUInt32LE(0);
      const header = Buffer.from(JSON.stringify({ ...entry, startSample: entry.startSample - 1 }));
      const size = Buffer.alloc(4);
      size.writeUInt32LE(header.length);
      fs.writeFileSync(
        file,
        f.encryption.encryptBytes(Buffer.concat([size, header, packet.subarray(4 + length)]))
      );
    }
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    await f.store.legacyRecovery.done;
    const saved = f.database.db
      .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id=?")
      .get(candidate.id);
    assert.equal(saved.recovery_reason, "source_integrity_failed");
    assert.equal(saved.recovery_attempts, 3);
    assert.equal(saved.recovery_pcm_hash, null);
    assert.equal(f.database.getVoiceExemplarAudio().length, 0);
    if (defect === "gap" || defect === "authenticated index mismatch") assert.equal(decoded, 0);
    t.diagnostic(
      `seventh ${defect}: reason=source_integrity_failed attempts=3 decoded=${decoded} baseline=null clips=0`
    );
  });
}

for (const change of [
  "locked orphan repair",
  "locked fully unindexed repair",
  "reencrypted",
  "rechunked/reencoded",
  "changed audio outside approved span",
  "different PCM",
]) {
  test(`sixth run: ${change}`, async (t) => {
    const { f, candidate, playback } = await sixthFixture(t);
    const approvedPcm = playback.wav.subarray(44);
    const originalId = f.store._manifest(f.noteId).recordingId;
    if (change === "reencrypted") {
      const chunk = f.store._manifest(f.noteId).tracks.mic.chunks[0];
      const file = path.join(directory, "recordings", String(f.noteId), chunk.file);
      fs.writeFileSync(
        file,
        f.encryption.encryptBytes(f.encryption.decryptBytes(fs.readFileSync(file)))
      );
    } else if (!change.startsWith("locked")) {
      rewriteChunks(f, (pcm) => {
        if (change === "different PCM") pcm[RATE * 2] ^= 127;
        if (change === "changed audio outside approved span") {
          assert.ok(candidate.startSample * 2 > 200);
          pcm[200] ^= 127;
        }
        return [pcm.subarray(0, RATE * 2), pcm.subarray(RATE * 2)];
      });
    } else {
      rewriteChunks(f, (pcm) => [pcm.subarray(0, RATE * 2), pcm.subarray(RATE * 2)]);
      const file = path.join(directory, "recordings", String(f.noteId), "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(file));
      manifest.tracks.mic.chunks.pop(); // A genuine durable orphan, absent from the index.
      if (change === "locked fully unindexed repair") manifest.tracks.mic.chunks = [];
      fs.writeFileSync(file, JSON.stringify(manifest));
      const decrypt = f.encryption.decryptBytes;
      f.encryption.decryptBytes = () => {
        throw Object.assign(Error("locked"), { code: "audio_key_unavailable" });
      };
      f.restart();
      await waitForRecoveryFailure(f, t);
      assert.equal(
        f.store._manifest(f.noteId).tracks.mic.chunks.length,
        change === "locked fully unindexed repair" ? 0 : 1
      );
      assert.equal(f.store.enforce().removed.length, 0);
      f.encryption.decryptBytes = decrypt;
    }
    f.restart();
    const sourceBefore =
      change === "different PCM"
        ? f.store._ownedChunks(f.noteId).map((file) => [file, fs.readFileSync(file)])
        : [];
    await f.store.legacyRecovery.done;
    const saved = f.database.db
      .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id=?")
      .get(candidate.id);
    const chunks = f.store._manifest(f.noteId).tracks.mic.chunks.length;
    const legacy = !!f.database.db
      .prepare("SELECT 1 FROM voice_exemplars WHERE id=?")
      .get(candidate.id);
    const sameRecording = f.store._manifest(f.noteId).recordingId === originalId;
    const decodedSource = f.store.span(
      f.noteId,
      candidate.track,
      candidate.startSample / RATE,
      candidate.endSample / RATE
    );
    assert.equal(decodedSource.state, "available");
    const pcmEqual = decodedSource.wav.subarray(44).equals(approvedPcm);
    assert.equal(pcmEqual, change !== "different PCM");
    if (change === "different PCM") {
      assert.equal(saved.state, "recovery_failed");
      assert.equal(saved.recovery_reason, "audio_content_mismatch");
      assert.equal(f.database.getVoiceExemplarAudio().length, 0);
      f.advance(4);
      assert.equal(f.store.enforce().removed.length, 0);
      for (const [file, bytes] of sourceBefore) assert.deepEqual(fs.readFileSync(file), bytes);
    } else {
      const recovered = enrollment.play(f.database, f.store, candidate.id);
      assert.equal(recovered.state, "available");
      assert.deepEqual(recovered.wav.subarray(44), approvedPcm);
      assert.equal(saved.state, "resolved");
      assert.equal(f.store.legacyRecovery.recovered, 1);
      assert.equal(saved.recovery_reason, "source_repaired");
    }
    assert.equal(sameRecording, true);
    assert.ok(chunks > 0);
    assert.equal(legacy, true);
    assert.equal(f.store.enforce().removed.length, 0);
    t.diagnostic(
      `sixth ${change}: sameRecording=${sameRecording} pcmEqual=${pcmEqual} state=${saved.state} reason=${saved.recovery_reason} recovered=${f.store.legacyRecovery.recovered} sourceChunks=${chunks} legacyApproval=retained deletions=0`
    );
  });
}

test("sixth run: failed evidence has a fixed expiry and approval survives retention", async (t) => {
  const { f, candidate } = await sixthFixture(t);
  rewriteChunks(f, (pcm) => {
    pcm[RATE * 2] ^= 127;
    return [pcm];
  });
  f.restart();
  await f.store.legacyRecovery.done;
  f.advance(4);
  assert.equal(f.store.enforce().removed.length, 0);
  const deadline = f.database.db
    .prepare("SELECT recovery_expires_at FROM voice_evidence_provenance WHERE sample_id=?")
    .get(candidate.id).recovery_expires_at;
  f.restart();
  await f.store.legacyRecovery.done;
  assert.equal(f.store.enforce().removed.length, 0);
  assert.equal(
    f.database.db
      .prepare("SELECT recovery_expires_at FROM voice_evidence_provenance WHERE sample_id=?")
      .get(candidate.id).recovery_expires_at,
    deadline
  );
  f.advance(4);
  assert.equal(f.store.enforce().removed.length, 1);
  const saved = f.database.db
    .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id=?")
    .get(candidate.id);
  assert.equal(saved.state, "unrecoverable");
  assert.equal(saved.recovery_reason, "evidence_retention_expired");
  assert.equal(f.store._manifest(f.noteId).status, "expired");
  assert.ok(f.database.db.prepare("SELECT 1 FROM voice_exemplars WHERE id=?").get(candidate.id));
  assert.equal(enrollment.progress(f.database, f.person.id).unrecoverable, 1);
  t.diagnostic(
    `sixth failed retention: day4=retained restartDeadlineUnchanged=true day8=${f.store._manifest(f.noteId).status} state=${saved.state} reason=${saved.recovery_reason} legacyApproval=retained`
  );
});

test("sixth run: changed approval bounds refuse recovery without erasing evidence", async (t) => {
  const { f, candidate } = await sixthFixture(t);
  f.database.db
    .prepare("UPDATE voice_exemplars SET start_sample=start_sample+1 WHERE id=?")
    .run(candidate.id);
  f.restart();
  await f.store.legacyRecovery.done;
  const saved = f.database.db
    .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id=?")
    .get(candidate.id);
  assert.equal(saved.state, "recovery_failed");
  assert.equal(saved.recovery_reason, "approved_span_mismatch");
  assert.equal(f.store.enforce().removed.length, 0);
  assert.ok(f.database.db.prepare("SELECT 1 FROM voice_exemplars WHERE id=?").get(candidate.id));
  assert.ok(f.store._manifest(f.noteId).tracks.mic.chunks.length);
});

test("sixth run: a missing legacy vector does not release audio evidence", async (t) => {
  const { f, candidate } = await sixthFixture(t);
  f.database.db.prepare("UPDATE voice_exemplars SET embedding=x'' WHERE id=?").run(candidate.id);
  f.restart();
  await f.store.legacyRecovery.done;
  const saved = f.database.db
    .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id=?")
    .get(candidate.id);
  assert.equal(saved.state, "recovery_failed");
  assert.equal(saved.recovery_reason, "legacy_embedding_unavailable");
  assert.equal(f.store.enforce().removed.length, 0);
  assert.ok(f.database.db.prepare("SELECT 1 FROM voice_exemplars WHERE id=?").get(candidate.id));
  assert.ok(f.store._manifest(f.noteId).tracks.mic.chunks.length);
});

test("sixth run: healthy resolved evidence is unchanged", async (t) => {
  const f = fixture(t);
  const { candidate, playback } = await f.approve();
  const before = f.database.db
    .prepare("SELECT * FROM voice_exemplar_audio WHERE id=?")
    .get(candidate.id);
  const provenanceBefore = f.database.db
    .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id=?")
    .get(candidate.id);
  f.advance(30);
  f.restart();
  await f.store.legacyRecovery.done;
  assert.deepEqual(
    f.database.db.prepare("SELECT * FROM voice_exemplar_audio WHERE id=?").get(candidate.id),
    before
  );
  assert.deepEqual(enrollment.play(f.database, f.store, candidate.id).wav, playback.wav);
  assert.equal(enrollment.listSamples(f.database, f.person.id)[0].provenance, "resolved");
  assert.deepEqual(
    f.database.db
      .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id=?")
      .get(candidate.id),
    provenanceBefore
  );
  assert.equal(f.store._manifest(f.noteId).status, "expired");
  assert.equal(f.database.getVoiceExemplarAudio().length, 1);
  t.diagnostic(
    "sixth healthy resolved: durableRowUnchanged=true pcmEqual=true state=resolved source=expired clips=1"
  );
});

test("sixth run: real Opus to FLAC reencoding and rechunking preserves approved PCM", async (t) => {
  const { defaultCodec } = require("../../src/helpers/meetingAudioStore");
  const { getFFmpegPath } = require("../../src/helpers/ffmpegUtils");
  const { execFileSync } = require("node:child_process");
  const { f, candidate, playback } = await sixthFixture(t, { codec: defaultCodec });
  rewriteChunks(f, (pcm) => [pcm.subarray(0, RATE * 2), pcm.subarray(RATE * 2)], {
    decode: defaultCodec.decode,
    encode: (pcm) =>
      execFileSync(
        getFFmpegPath(),
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "s16le",
          "-ar",
          "24000",
          "-ac",
          "1",
          "-i",
          "pipe:0",
          "-c:a",
          "flac",
          "-f",
          "ogg",
          "pipe:1",
        ],
        { input: pcm, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }
      ),
  });
  f.restart();
  await f.store.legacyRecovery.done;
  const recovered = enrollment.play(f.database, f.store, candidate.id);
  assert.equal(recovered.state, "available");
  assert.deepEqual(recovered.wav.subarray(44), playback.wav.subarray(44));
  const saved = f.database.db
    .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id=?")
    .get(candidate.id);
  assert.equal(saved.recovery_reason, "source_repaired");
  assert.equal(f.store._manifest(f.noteId).tracks.mic.chunks.length, 2);
  assert.equal(f.store.enforce().removed.length, 0);
  t.diagnostic(
    "sixth real ffmpeg: Opus→Ogg/FLAC chunks=1→2 pcmEqual=true state=resolved reason=source_repaired source=retained"
  );
});

test("fourth run: constructor returns with recovery queued and yields between capped passes", async (t) => {
  const { f, candidate } = await legacyFixture(t, { recovery: { passLimit: 2, yieldMs: 1 } });
  for (let i = 0; i < 4; i++)
    f.database.db
      .prepare(
        `INSERT INTO voice_exemplars
    (id, profile_id, note_id, row_ids, track, start_sample, end_sample, embedding, approved_at)
    SELECT ?, profile_id, note_id, row_ids, track, start_sample, end_sample, embedding, approved_at
    FROM voice_exemplars WHERE id = ?`
      )
      .run(`queued-${i}`, candidate.id);
  f.advance(30);
  f.restart();
  assert.equal(
    f.database.getVoiceExemplarAudio().length,
    0,
    "startup must complete before decoding"
  );
  assert.equal(f.store.enforce().removed.length, 0, "all queued sources must be protected");
  assert.equal(
    f.store.status(f.noteId).state,
    "complete",
    "pending sources are still retained past their original deadline"
  );
  assert.ok(f.store.usage().usedBytes > 0, "protected bytes must count against the disk budget");
  t.diagnostic(
    `startup complete: queued=5 clips=0 protected=${f.store.legacyRecovery.deferredNotes.length}`
  );
  let heartbeats = 0;
  const heartbeat = setInterval(() => heartbeats++, 0);
  await f.store.legacyRecovery.done;
  clearInterval(heartbeat);
  assert.equal(f.database.getVoiceExemplarAudio().length, 5);
  assert.ok(heartbeats >= 4);
  assert.ok(f.store.legacyRecovery.maxPassItems <= 2);
  assert.equal(f.store.legacyRecovery.deferredNotes.length, 0);
  assert.equal(f.store._manifest(f.noteId).status, "expired");
  t.diagnostic(
    `bounded completion: recovered=5 passes=${f.store.legacyRecovery.passes} maxPassItems=${f.store.legacyRecovery.maxPassItems} heartbeats=${heartbeats}`
  );
});

test("fourth run: decoder timeout retries and succeeds without re-review", async (t) => {
  let attempts = 0;
  const production = require("../../src/helpers/meetingAudioStore").defaultCodec;
  const { f, candidate, playback } = await legacyFixture(t, {
    codec: {
      ...production,
      decodeAsync: (bytes, options) =>
        production.decodeAsync(bytes, {
          ...options,
          timeout: ++attempts === 1 ? 1 : 5000,
        }),
    },
    recovery: { retryBaseMs: 1, yieldMs: 1 },
  });
  f.advance(30);
  f.restart();
  await f.store.legacyRecovery.done;
  assert.equal(attempts, 2);
  assert.equal(f.store.legacyRecovery.recovered, 1);
  assert.deepEqual(enrollment.play(f.database, f.store, candidate.id).wav, playback.wav);
  assert.equal(enrollment.progress(f.database, f.person.id).unrecoverable, 0);
  t.diagnostic(
    `decoder-timeout then success: realProcessTimeout=true attempts=${attempts} recovered=1 bytesEqual=true unrecoverable=0`
  );
});

for (const code of ["ENOENT", "EBUSY", "EAGAIN"]) {
  test(`fourth run: decoder ${code} is temporary and retries`, async (t) => {
    let attempts = 0;
    const { f } = await legacyFixture(t, {
      codec: {
        ...codec,
        decodeAsync: async (bytes) => {
          if (++attempts === 1) throw Object.assign(Error("decoder unavailable"), { code });
          return codec.decode(bytes);
        },
      },
      recovery: { retryBaseMs: 1, yieldMs: 1 },
    });
    f.restart();
    await f.store.legacyRecovery.done;
    assert.equal(attempts, 2);
    assert.equal(f.store.legacyRecovery.recovered, 1);
    assert.equal(f.store.legacyRecovery.unrecoverable, 0);
  });
}

for (const kind of ["chunk", "manifest"]) {
  test(`fourth run: transient ${kind} IO is retried instead of classified as missing audio`, async (t) => {
    const { f } = await legacyFixture(t, { recovery: { retryBaseMs: 1, yieldMs: 1 } });
    const file = path.join(
      directory,
      "recordings",
      String(f.noteId),
      kind === "manifest" ? "manifest.json" : f.store._manifest(f.noteId).tracks.mic.chunks[0].file
    );
    f.restart();
    const read = fs.readFileSync;
    let failed = false;
    fs.readFileSync = function (target, ...args) {
      if (target === file && !failed) {
        failed = true;
        throw Object.assign(Error("transient read failure"), { code: "EIO" });
      }
      return read.call(this, target, ...args);
    };
    t.after(() => {
      fs.readFileSync = read;
    });
    await f.store.legacyRecovery.done;
    assert.equal(failed, true);
    assert.equal(f.store.legacyRecovery.recovered, 1);
    assert.equal(f.store.legacyRecovery.failures[0].reason, "EIO");
  });
}

test("fourth run: eviction protects later pages and releases each completed source", async (t) => {
  const { f } = await legacyFixture(t, { recovery: { passLimit: 1, yieldMs: 1 } });
  f.addMeeting();
  const other = await f.approve();
  f.database.db.exec("DELETE FROM voice_exemplar_audio; DELETE FROM voice_evidence_provenance");
  f.restart();
  f.store.policy.budgetBytes = 1;
  assert.equal(f.store.enforce().removed.length, 0);
  assert.deepEqual(
    f.store.legacyRecovery.deferredNotes.sort(),
    [f.noteId, other.candidate.noteId].sort()
  );
  while (f.store.legacyRecovery.recovered < 1)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(f.store.legacyRecovery.deferredNotes.length, 1);
  assert.equal(
    f.store.enforce().removed.length,
    1,
    "finished source is immediately evictable while next page stays protected"
  );
  await f.store.legacyRecovery.done;
  assert.equal(f.store.legacyRecovery.recovered, 2);
  assert.equal(f.store._manifest(f.noteId).status, "evicted");
  assert.equal(f.store._manifest(other.candidate.noteId).status, "evicted");
  t.diagnostic(
    "eviction protection: queuedSources=2 evicted=0; after first classification: protected=1 evictable=1; recovered=2"
  );
});

test("fourth run: retry budget persists across restart and ends as recovery_failed", async (t) => {
  const { f, candidate } = await legacyFixture(t, {
    codec: {
      ...codec,
      decodeAsync: async () => {
        throw Error("decoder broken");
      },
    },
    recovery: { maxAttempts: 3, retryBaseMs: 1, yieldMs: 1 },
  });
  f.advance(30);
  f.restart();
  await f.store.legacyRecovery.done;
  const saved = f.database.db
    .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id = ?")
    .get(candidate.id);
  assert.equal(saved.state, "recovery_failed");
  assert.equal(saved.recovery_attempts, 3);
  assert.equal(enrollment.progress(f.database, f.person.id).recoveryFailed, 1);
  assert.equal(f.store._manifest(f.noteId).status, "complete");
  assert.equal(f.store.legacyRecovery.protects(f.noteId), true);
  f.restart();
  await f.store.legacyRecovery.done;
  assert.equal(f.store.legacyRecovery.attempted, 0);
  t.diagnostic(
    `budget exhausted: state=${saved.state} attempts=${saved.recovery_attempts} reason=${saved.reason} restartAttempts=0 retention=protected`
  );
});

test("fifth run: retries preserve a classified identity and reject replacement audio", async (t) => {
  const { f, candidate } = await legacyFixture(t, {
    codec: {
      ...codec,
      decodeAsync: async () => {
        throw Error("decoder busy");
      },
    },
    recovery: { retryBaseMs: 30, yieldMs: 1 },
  });
  const db = f.database.db;
  const { classifyEvidence } = require("../../src/helpers/voiceRecordingIdentity");
  const sample = db.prepare("SELECT * FROM voice_exemplars WHERE id = ?").get(candidate.id);
  const prior = classifyEvidence(db, sample, { store: f.store, record: true }).recordingId;
  f.restart();
  while (!f.store.legacyRecovery.failures.length)
    await new Promise((resolve) => setTimeout(resolve, 1));
  const saved = f.database.db
    .prepare(
      "SELECT state, recovery_recording_id FROM voice_evidence_provenance WHERE sample_id = ?"
    )
    .get(candidate.id);
  assert.equal(saved.state, "resolved");
  assert.equal(saved.recovery_recording_id, prior);
  const file = path.join(directory, "recordings", String(f.noteId), "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file));
  manifest.recordingId = crypto.randomUUID();
  fs.writeFileSync(file, JSON.stringify(manifest));
  await f.store.legacyRecovery.done;
  assert.deepEqual(classifyEvidence(f.database.db, sample), {
    state: "resolved",
    recordingId: prior,
  });
  const final = f.database.db
    .prepare(
      "SELECT recovery_state, recovery_reason FROM voice_evidence_provenance WHERE sample_id = ?"
    )
    .get(candidate.id);
  assert.deepEqual(final, {
    recovery_state: "recovery_failed",
    recovery_reason: "recording_identity_mismatch",
  });
  assert.equal(f.database.getVoiceExemplarAudio().length, 0);
});

for (const [replacement, restart] of [
  ["identity", false],
  ["identity", true],
  ["content", false],
]) {
  test(`fifth run: unclassified retry refuses replaced source ${replacement} (restart=${restart})`, async (t) => {
    let attempts = 0;
    let pinnedBeforeDecode = false;
    const { f, candidate } = await legacyFixture(t, {
      codec: {
        ...codec,
        decodeAsync: async (bytes) => {
          const pin = f.database.db
            .prepare(
              "SELECT recovery_recording_id, recovery_content_hash FROM voice_evidence_provenance WHERE sample_id = ?"
            )
            .get(candidate.id);
          pinnedBeforeDecode = Boolean(
            pin?.recovery_recording_id && /^[a-f0-9]{64}$/.test(pin.recovery_content_hash)
          );
          if (++attempts === 1 && replacement === "identity") throw Error("decoder busy");
          return codec.decode(bytes);
        },
      },
      recovery: { retryBaseMs: 30, yieldMs: 1 },
    });
    const original = f.store._manifest(f.noteId);
    if (replacement === "content") {
      const encrypt = f.encryption.encryptBytes;
      let calls = 0;
      f.encryption.encryptBytes = (bytes) => {
        if (++calls === 1) throw Error("temporarily unable to seal clip");
        return encrypt(bytes);
      };
    }
    f.restart();
    while (!f.store.legacyRecovery.failures.length)
      await new Promise((resolve) => setTimeout(resolve, 1));
    const saved = f.database.db
      .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id = ?")
      .get(candidate.id);
    // Change the source before asserting, so the original bug also exercises
    // the actual retry and proves it saves replacement bytes as resolved.
    if (replacement === "identity") {
      const file = path.join(directory, "recordings", String(f.noteId), "manifest.json");
      fs.writeFileSync(file, JSON.stringify({ ...original, recordingId: crypto.randomUUID() }));
    } else {
      assert.match(saved.recovery_pcm_hash, /^[a-f0-9]{64}$/);
      rewriteChunks(f, (pcm) => {
        pcm[RATE * 2] ^= 127;
        return [pcm];
      });
    }
    if (restart) f.restart();
    await f.store.legacyRecovery.done;
    const final = f.database.db
      .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id = ?")
      .get(candidate.id);
    assert.equal(final.state, "recovery_failed");
    assert.equal(
      final.reason,
      replacement === "identity" ? "recording_identity_mismatch" : "audio_content_mismatch"
    );
    assert.equal(saved.recovery_recording_id, original.recordingId);
    assert.match(saved.recovery_content_hash, /^[a-f0-9]{64}$/);
    assert.equal(attempts, replacement === "identity" ? 1 : 2);
    assert.equal(pinnedBeforeDecode, true);
    assert.equal(f.database.getVoiceExemplarAudio().length, 0);
    t.diagnostic(
      `replaced source ${replacement}: restart=${restart} state=${final.state} reason=${final.reason} decodeAttempts=${attempts} clips=0 pinnedBeforeDecode=true`
    );
  });
}

test("fifth run: resolved classification survives three temporary failures and restart", async (t) => {
  const { f, candidate } = await legacyFixture(t, {
    codec: {
      ...codec,
      decodeAsync: async () => {
        throw Error("decoder busy");
      },
    },
    recovery: { retryBaseMs: 1, yieldMs: 1 },
  });
  const { classifyEvidence } = require("../../src/helpers/voiceRecordingIdentity");
  const sample = f.database.db
    .prepare("SELECT * FROM voice_exemplars WHERE id = ?")
    .get(candidate.id);
  const prior = classifyEvidence(f.database.db, sample, { store: f.store, record: true });
  f.advance(30);
  f.restart();
  await f.store.legacyRecovery.done;
  const saved = f.database.db
    .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id = ?")
    .get(candidate.id);
  assert.deepEqual(classifyEvidence(f.database.db, sample), prior);
  assert.equal(saved.recovery_attempts, 3);
  assert.equal(saved.recovery_state, "recovery_failed");
  assert.equal(saved.recovery_reason, "decoder_error");
  assert.equal(enrollment.progress(f.database, f.person.id).recoveryFailed, 1);
  assert.equal(f.store.legacyRecovery.protects(f.noteId), true);
  f.restart();
  await f.store.legacyRecovery.done;
  assert.equal(f.store.legacyRecovery.attempted, 0);
  assert.deepEqual(classifyEvidence(f.database.db, sample), prior);
  t.diagnostic(
    `resolved survives: classification=${saved.state} recordingIdPreserved=true conversion=${saved.recovery_state} attempts=${saved.recovery_attempts} restartAttempts=0 retention=${f.store._manifest(f.noteId).status}`
  );
});

for (const code of ["EACCES", "EBUSY", "ENOENT"]) {
  test(`fifth run: source stat ${code} preserves its IO classification`, async (t) => {
    const { f, candidate } = await legacyFixture(t, { recovery: { retryBaseMs: 1, yieldMs: 1 } });
    const file = path.join(
      directory,
      "recordings",
      String(f.noteId),
      f.store._manifest(f.noteId).tracks.mic.chunks[0].file
    );
    f.restart();
    const stat = fs.lstatSync;
    const exists = fs.existsSync;
    let failed = false;
    // Real loss exercises native ENOENT. For temporary failures, model the
    // existsSync contract: native stat errors become false.
    if (code === "ENOENT") fs.unlinkSync(file);
    fs.existsSync = function (target) {
      if (target === file && !failed && code !== "ENOENT") return false;
      return exists.call(this, target);
    };
    fs.lstatSync = function (target, ...args) {
      if (target === file && !failed && code !== "ENOENT") {
        failed = true;
        throw Object.assign(Error("injected source stat failure"), { code });
      }
      return stat.call(this, target, ...args);
    };
    t.after(() => {
      fs.lstatSync = stat;
      fs.existsSync = exists;
    });
    await f.store.legacyRecovery.done;
    const saved = f.database.db
      .prepare("SELECT * FROM voice_evidence_provenance WHERE sample_id = ?")
      .get(candidate.id);
    if (code === "ENOENT") {
      assert.equal(saved.state, "unrecoverable");
      assert.equal(f.store.legacyRecovery.attempted, 1);
      assert.equal(f.store.legacyRecovery.recovered, 0);
    } else {
      assert.equal(failed, true);
      assert.equal(f.store.legacyRecovery.failures[0].reason, code);
      assert.equal(f.store.legacyRecovery.attempted, 2);
      assert.equal(f.store.legacyRecovery.recovered, 1);
    }
    assert.equal(f.store.legacyRecovery.protects(f.noteId), false);
    t.diagnostic(
      `source stat ${code}: state=${saved.state} attempted=${f.store.legacyRecovery.attempted} recovered=${f.store.legacyRecovery.recovered} retryReason=${f.store.legacyRecovery.failures[0]?.reason || "none"} protected=false`
    );
  });
}

for (const safeStorageAvailable of [false, true]) {
  test(`fifth run: cached keychain fallback refreshes on retry (safeStorage=${safeStorageAvailable})`, async (t) => {
    const { f } = await legacyFixture(t, { recovery: { retryBaseMs: 30, yieldMs: 1 } });
    const key = crypto.randomBytes(32);
    const chunk = f.store._manifest(f.noteId).tracks.mic.chunks[0];
    const file = path.join(directory, "recordings", String(f.noteId), chunk.file);
    const plaintext = f.encryption.decryptBytes(fs.readFileSync(file));
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    fs.writeFileSync(
      file,
      Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
    );
    let unlocked = false;
    let reads = 0;
    let writes = 0;
    const originalLoad = Module._load;
    Module._load = function (request, ...args) {
      if (request === "electron")
        return {
          app: { getPath: () => directory },
          safeStorage: { isEncryptionAvailable: () => safeStorageAvailable },
        };
      if (request === "@napi-rs/keyring")
        return {
          Entry: class {
            getPassword() {
              reads++;
              if (!unlocked) throw Error("locked");
              return key.toString("base64");
            }
            setPassword() {
              writes++;
            }
          },
        };
      return originalLoad.call(this, request, ...args);
    };
    t.after(() => {
      Module._load = originalLoad;
    });
    const modulePath = require.resolve("../../src/helpers/secretCrypto");
    delete require.cache[modulePath];
    const secrets = require(modulePath);
    Object.assign(f.encryption, secrets);
    f.restart();
    while (!f.store.legacyRecovery.failures.length)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(f.store.legacyRecovery.failures[0].reason, "audio_key_unavailable");
    assert.equal(reads, 1);
    unlocked = true;
    // Ordinary reads still use the cached fallback until the bounded retry.
    assert.throws(() => secrets.decryptBytes(Buffer.alloc(64)), { code: "audio_key_unavailable" });
    assert.equal(reads, 1);
    await f.store.legacyRecovery.done;
    assert.equal(f.store.legacyRecovery.recovered, 1);
    assert.equal(reads, 2);
    assert.equal(writes, 0);
    t.diagnostic(
      `keychain unlock: safeStorage=${safeStorageAvailable} before=audio_key_unavailable readsBefore=1 readsAfter=${reads} recovered=${f.store.legacyRecovery.recovered} keyWrites=${writes}`
    );
  });
}

test("fourth run: valid-key ciphertext corruption retains evidence through the fixed hold", async (t) => {
  const { f, candidate } = await legacyFixture(t, { recovery: { retryBaseMs: 1, yieldMs: 1 } });
  const chunk = f.store._manifest(f.noteId).tracks.mic.chunks[0];
  const file = path.join(directory, "recordings", String(f.noteId), chunk.file);
  const bytes = fs.readFileSync(file);
  bytes[20] ^= 1;
  fs.writeFileSync(file, bytes);
  f.advance(30);
  f.restart();
  await f.store.legacyRecovery.done;
  const saved = f.database.db
    .prepare("SELECT state, reason FROM voice_evidence_provenance WHERE sample_id = ?")
    .get(candidate.id);
  assert.deepEqual(saved, { state: "recovery_failed", reason: "audio_corrupt" });
  assert.equal(f.store.legacyRecovery.deferredNotes.length, 0);
  assert.equal(f.store._manifest(f.noteId).status, "complete");
  assert.equal(fs.existsSync(file), true);
  f.restart();
  await f.store.legacyRecovery.done;
  assert.equal(f.store.legacyRecovery.attempted, 0);
  assert.equal(enrollment.progress(f.database, f.person.id).pendingRecovery, 0);
  t.diagnostic(
    `corrupt ciphertext + valid key: ${JSON.stringify(saved)} deferred=0 retention=protected chunkExists=true`
  );
});

test("fourth run: missing key stays pending and protected, then retries after unlock", async (t) => {
  const { f, candidate } = await legacyFixture(t, { recovery: { retryBaseMs: 30, yieldMs: 1 } });
  const decrypt = f.encryption.decryptBytes;
  f.encryption.decryptBytes = () => {
    throw Object.assign(Error("locked"), { code: "audio_key_unavailable" });
  };
  f.advance(30);
  f.restart();
  while (!f.store.legacyRecovery.failures.length)
    await new Promise((resolve) => setTimeout(resolve, 1));
  const saved = f.database.db
    .prepare(
      "SELECT state, reason, recovery_attempts, recovery_next_at FROM voice_evidence_provenance WHERE sample_id = ?"
    )
    .get(candidate.id);
  assert.equal(saved.state, "pending_recovery");
  assert.equal(saved.reason, "audio_key_unavailable");
  assert.equal(saved.recovery_attempts, 1);
  assert.equal(f.store.enforce().removed.length, 0);
  assert.equal(f.store._manifest(f.noteId).status, "complete");
  assert.equal(f.database.getSpeakerProfiles(true).length, 0);
  t.diagnostic(
    `missing key: state=${saved.state} attempts=1 deferred=1 retained=complete recognitionProfiles=0`
  );
  f.restart(); // Backoff and spent attempts survive a restart.
  assert.equal(f.database.getVoiceExemplarAudio().length, 0);
  assert.equal(
    f.database.db
      .prepare("SELECT recovery_next_at FROM voice_evidence_provenance WHERE sample_id = ?")
      .get(candidate.id).recovery_next_at,
    saved.recovery_next_at
  );
  f.encryption.decryptBytes = decrypt;
  await f.store.legacyRecovery.done;
  assert.equal(f.store.legacyRecovery.recovered, 1);
  assert.equal(f.store.legacyRecovery.deferredNotes.length, 0);
  t.diagnostic("key unlocked: persistedBackoff=true recovered=1 deferred=0");
});

test("fourth run: a permanently missing key exhausts honestly and never creates a clip", async (t) => {
  const { f, candidate } = await legacyFixture(t, { recovery: { retryBaseMs: 1, yieldMs: 1 } });
  f.encryption.decryptBytes = () => {
    throw Object.assign(Error("locked"), { code: "audio_key_unavailable" });
  };
  f.advance(30);
  f.restart();
  await f.store.legacyRecovery.done;
  const saved = f.database.db
    .prepare(
      "SELECT state, reason, recovery_attempts FROM voice_evidence_provenance WHERE sample_id = ?"
    )
    .get(candidate.id);
  assert.deepEqual(saved, {
    state: "recovery_failed",
    reason: "audio_key_unavailable",
    recovery_attempts: 3,
  });
  assert.equal(f.database.getVoiceExemplarAudio().length, 0);
  assert.equal(f.store._manifest(f.noteId).status, "complete");
  t.diagnostic(`missing key budget: ${JSON.stringify(saved)} clips=0 retention=protected`);
});

test("fourth run: cancellation aborts an active decoder and queued work can resume", async (t) => {
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  let aborted = false;
  let stall = true;
  const { f } = await legacyFixture(t, {
    codec: {
      ...codec,
      decodeAsync: (bytes, { signal }) => {
        if (!stall) return Promise.resolve(codec.decode(bytes));
        started();
        return new Promise((_, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(Object.assign(Error("cancelled"), { code: "ABORT_ERR" }));
            },
            { once: true }
          )
        );
      },
    },
  });
  f.restart();
  await entered;
  const queue = f.store.legacyRecovery;
  f.store.cancelRecovery();
  await queue.done;
  assert.equal(aborted, true);
  assert.equal(queue.deferredNotes.length, 0);
  assert.equal(f.database.getVoiceExemplarAudio().length, 0);
  stall = false;
  f.restart();
  await f.store.legacyRecovery.done;
  assert.equal(f.store.legacyRecovery.recovered, 1);
  t.diagnostic("cancel: decoderAborted=true clips=0; resume: recovered=1");
});

test("fourth run: revoking approval during decoding cannot resurrect its clip", async (t) => {
  let entered, finishDecode;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const { f, candidate } = await legacyFixture(t, {
    codec: {
      ...codec,
      decodeAsync: (bytes) => {
        entered();
        return new Promise((resolve) => {
          finishDecode = () => resolve(codec.decode(bytes));
        });
      },
    },
  });
  f.restart();
  await started;
  f.database.db.prepare("DELETE FROM voice_exemplars WHERE id = ?").run(candidate.id);
  finishDecode();
  await f.store.legacyRecovery.done;
  assert.equal(f.database.getVoiceExemplarAudio().length, 0);
  assert.equal(f.store.legacyRecovery.recovered, 0);
});

test("third run: legacy-only unrecognised evidence cannot return a recognition profile", (t) => {
  const f = fixture(t);
  const db = f.database.db;
  const embedding = Buffer.from(
    Float32Array.from({ length: 512 }, (_, i) => Number(i === 0)).buffer
  );
  db.prepare(
    `INSERT INTO voice_exemplars
    (id, profile_id, note_id, row_ids, track, start_sample, end_sample, embedding, approved_at)
    VALUES ('unknown', ?, ?, '["approved-row"]', 'mic', 0, 96000, ?, CURRENT_TIMESTAMP)`
  ).run(f.person.id, f.noteId, embedding);
  const doc = JSON.parse(f.database.getNote(f.noteId).transcript);
  delete doc.rows[0].audioSpan.recordingId;
  db.prepare("UPDATE notes SET transcript = ? WHERE id = ?").run(JSON.stringify(doc), f.noteId);
  db.prepare(
    "UPDATE speaker_profiles SET embedding = ?, sample_count = 1, voice_usable = 1 WHERE id = ?"
  ).run(embedding, f.person.id);
  const result = {
    usable: enrollment.progress(f.database, f.person.id).usable,
    resolvedBytes: enrollment.resolveProfile(db, f.person.id).embedding.length,
    recognitionProfiles: f.database.getSpeakerProfiles(true).length,
    provisionalProfiles: f.database.getSpeakerProfiles(true, { includeProvisional: true }).length,
  };
  t.diagnostic(`unrecognised-evidence recognition: ${JSON.stringify(result)}`);
  assert.deepEqual(result, {
    usable: false,
    resolvedBytes: 0,
    recognitionProfiles: 0,
    provisionalProfiles: 0,
  });
  assert.equal(
    f.database.getSpeakerProfiles().find((profile) => profile.id === f.person.id).voice_usable,
    0
  );
});

test("third run: unresolved evidence stays pending through three scans, deletion and restart", async (t) => {
  const f = fixture(t);
  await f.approve();
  f.addMeeting();
  await f.approve();
  f.addMeeting();
  await f.approve();
  const db = f.database.db;
  // Reproduce an old unresolved approval, with no surviving recording manifest.
  db.exec(
    "UPDATE voice_exemplar_audio SET recording_id = NULL; UPDATE voice_exemplars SET recording_id = NULL"
  );
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'voice_evidence_provenance'").get())
    db.exec("DELETE FROM voice_evidence_provenance");
  for (const note of db.prepare("SELECT id, transcript FROM notes").all()) {
    const doc = JSON.parse(note.transcript);
    for (const row of doc.rows) delete row.audioSpan.recordingId;
    db.prepare("UPDATE notes SET transcript = ? WHERE id = ?").run(JSON.stringify(doc), note.id);
    fs.unlinkSync(path.join(directory, "recordings", String(note.id), "manifest.json"));
  }
  const summary = () => {
    const { meetings, usable } = enrollment.progress(f.database, f.person.id);
    return { meetings, usable };
  };
  const stages = [summary()];
  for (let i = 0; i < 3; i++) {
    enrollment.candidateReport(f.database, f.store, f.person.id);
    stages.push(summary());
  }
  f.store.delete(f.noteId);
  const tombstonePath = path.join(directory, "recordings", String(f.noteId), "manifest.json");
  const tombstone = JSON.parse(fs.readFileSync(tombstonePath, "utf8"));
  tombstone.recordingId = crypto.randomUUID(); // historical deletion-generated UUID
  fs.writeFileSync(tombstonePath, JSON.stringify(tombstone));
  enrollment.candidateReport(f.database, f.store, f.person.id);
  stages.push(summary());
  f.restart();
  await f.store.legacyRecovery.done;
  stages.push(summary());
  t.diagnostic(`three scans + deletion + restart: ${JSON.stringify(stages)}`);
  assert.ok(stages.every((item) => item.meetings === 0 && item.usable === false));
  assert.ok(
    enrollment
      .listSamples(f.database, f.person.id)
      .every((sample) => sample.provenance === "pending_recovery")
  );
});

test("third run: startup recovers legacy approval bytes before retention and is idempotent", async (t) => {
  const f = fixture(t);
  const { candidate, playback } = await f.approve();
  f.database.db.prepare("DELETE FROM voice_exemplar_audio WHERE id = ?").run(candidate.id);
  if (
    f.database.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'voice_evidence_provenance'")
      .get()
  )
    f.database.db.exec("DELETE FROM voice_evidence_provenance");
  f.database.db.exec("UPDATE voice_exemplars SET recording_id = NULL");
  // A second approval whose source audio is already gone must be reported.
  f.addMeeting();
  const other = await f.approve();
  f.database.db.prepare("DELETE FROM voice_exemplar_audio WHERE id = ?").run(other.candidate.id);
  fs.rmSync(path.join(directory, "recordings", String(other.candidate.noteId)), {
    recursive: true,
  });
  // Actual pre-classifier schema on disk, opened by DatabaseManager on restart.
  f.database.db.exec(
    "DROP TABLE voice_evidence_provenance; ALTER TABLE voice_exemplars DROP COLUMN recording_id"
  );
  f.advance(4);
  f.restart();
  await f.store.legacyRecovery.done;
  const audio = f.database.getVoiceExemplarAudio();
  const bytesEqual =
    audio.length === 1 &&
    enrollment.play(f.database, f.store, candidate.id).wav.equals(playback.wav);
  t.diagnostic(
    `startup legacy recovery: ${JSON.stringify({ report: f.store.legacyRecovery, bytesEqual, clips: audio.length })}`
  );
  assert.equal(bytesEqual, true);
  assert.equal(f.store.legacyRecovery.recovered, 1);
  assert.equal(f.store.legacyRecovery.unrecoverable, 1);
  assert.equal(enrollment.progress(f.database, f.person.id).unrecoverable, 1);
  assert.equal(
    f.database.db
      .prepare("SELECT state FROM voice_evidence_provenance WHERE sample_id = ?")
      .get(other.candidate.id).state,
    "unrecoverable"
  );
  const before = f.database.db.prepare("SELECT * FROM voice_exemplar_audio").get();
  f.restart();
  await f.store.legacyRecovery.done;
  assert.deepEqual(f.database.db.prepare("SELECT * FROM voice_exemplar_audio").get(), before);
  assert.equal(f.store.legacyRecovery.recovered, 0);
  t.diagnostic(`second startup: ${JSON.stringify(f.store.legacyRecovery)}`);
});

test("third run: startup recovers approvals even at the sample cap", async (t) => {
  const f = fixture(t);
  const { candidate, playback } = await f.approve();
  f.database.db.prepare("DELETE FROM voice_exemplar_audio WHERE id = ?").run(candidate.id);
  for (let i = 1; i < enrollment.MAX_SAMPLES; i++)
    f.database.db
      .prepare(
        `INSERT INTO voice_exemplars
      (id, profile_id, note_id, track, start_sample, end_sample, embedding, approved_at, row_ids)
      SELECT ?, profile_id, note_id, track, start_sample, end_sample, embedding, approved_at, row_ids
      FROM voice_exemplars WHERE id = ?`
      )
      .run(`legacy-at-cap-${i}`, candidate.id);
  f.database.db.exec("DROP TABLE voice_evidence_provenance");
  f.restart();
  await f.store.legacyRecovery.done;
  assert.equal(f.store.legacyRecovery.recovered, enrollment.MAX_SAMPLES);
  assert.equal(f.database.getVoiceExemplarAudio().length, enrollment.MAX_SAMPLES);
  for (const sample of f.database.getVoiceExemplarAudio())
    assert.deepEqual(enrollment.play(f.database, f.store, sample.id).wav, playback.wav);
  t.diagnostic(
    `startup at cap: ${JSON.stringify({ recovered: f.store.legacyRecovery.recovered, equalClips: enrollment.MAX_SAMPLES })}`
  );
});

test("third run: startup restores a graduated legacy profile without re-review", async (t) => {
  const f = fixture(t);
  await f.approve();
  f.addMeeting();
  await f.approve();
  f.addMeeting();
  await f.approve();
  f.database.db.exec(`DELETE FROM voice_exemplar_audio;
    DROP TABLE voice_evidence_provenance;
    UPDATE speaker_profiles SET voice_needs_reapproval = 0;
    UPDATE notes SET transcript = NULL;`);
  f.advance(4);
  f.restart();
  await f.store.legacyRecovery.done;
  const { meetings, cleanSpans, usable } = enrollment.progress(f.database, f.person.id);
  const profiles = f.database.getSpeakerProfiles(true).length;
  const result = {
    recovered: f.store.legacyRecovery.recovered,
    meetings,
    cleanSpans,
    usable,
    profiles,
  };
  t.diagnostic(`graduated legacy startup: ${JSON.stringify(result)}`);
  assert.deepEqual(result, { recovered: 3, meetings: 3, cleanSpans: 3, usable: true, profiles: 1 });
});

test("third run: temporary key loss defers recovery and holds source audio before retention", async (t) => {
  const f = fixture(t);
  const { candidate, playback } = await f.approve();
  f.database.db.prepare("DELETE FROM voice_exemplar_audio WHERE id = ?").run(candidate.id);
  f.database.db.exec("DROP TABLE voice_evidence_provenance");
  const decrypt = f.encryption.decryptBytes;
  f.encryption.decryptBytes = () => {
    throw Error("Temporarily unavailable");
  };
  f.advance(4);
  f.restart();
  while (!f.store.legacyRecovery.failures.length)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(f.store.legacyRecovery.pendingRecovery, 1);
  assert.equal(f.store.legacyRecovery.unrecoverable, 0);
  assert.deepEqual(f.store.legacyRecovery.deferredNotes, [f.noteId]);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, "recordings", String(f.noteId), "manifest.json"))
  );
  assert.equal(manifest.status, "complete");
  f.encryption.decryptBytes = decrypt;
  f.restart();
  await f.store.legacyRecovery.done;
  assert.equal(f.store.legacyRecovery.recovered, 1);
  assert.deepEqual(enrollment.play(f.database, f.store, candidate.id).wav, playback.wav);
});

test("third run: pending clip resolves once from its genuine manifest, never from scans", async (t) => {
  const f = fixture(t);
  const { candidate } = await f.approve();
  const db = f.database.db;
  db.exec("DELETE FROM voice_evidence_provenance");
  const manifestPath = path.join(directory, "recordings", String(f.noteId), "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const actualId = manifest.recordingId;
  delete manifest.recordingId;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  f.restart();
  await f.store.legacyRecovery.done;
  assert.equal(enrollment.progress(f.database, f.person.id).pendingRecovery, 1);
  assert.equal(enrollment.progress(f.database, f.person.id).meetings, 0);
  manifest.recordingId = actualId;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  enrollment.candidateReport(f.database, f.store, f.person.id);
  assert.equal(enrollment.progress(f.database, f.person.id).meetings, 0);
  f.restart();
  await f.store.legacyRecovery.done;
  assert.equal(enrollment.progress(f.database, f.person.id).meetings, 1);
  manifest.recordingId = crypto.randomUUID();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  f.restart();
  await f.store.legacyRecovery.done;
  assert.equal(
    f.database.db
      .prepare("SELECT recording_id FROM voice_evidence_provenance WHERE sample_id = ?")
      .get(candidate.id).recording_id,
    actualId
  );
});

test("third run: calibration cannot reuse a pending or unrecoverable approval through its transcript centroid", async (t) => {
  const f = fixture(t);
  const { candidate } = await f.approve();
  const db = f.database.db;
  const embedding = db
    .prepare("SELECT embedding FROM voice_exemplar_audio WHERE id = ?")
    .get(candidate.id).embedding;
  db.prepare(
    "INSERT INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, 'speaker_0', ?)"
  ).run(f.noteId, embedding);
  db.exec("DELETE FROM voice_evidence_provenance");
  const collect = () =>
    require("../../src/helpers/speakerInAppCalibration").collectRows(
      f.database,
      f.store,
      { kind: "all" },
      { notes: 10, rows: 10 }
    );
  const pendingRows = collect().rows.length;
  assert.equal(pendingRows, 0);
  // A legacy approval whose audio was declared lost is terminal even if a source
  // later appears. Its matching note centroid must remain excluded too.
  db.prepare("DELETE FROM voice_exemplar_audio WHERE id = ?").run(candidate.id);
  require("../../src/helpers/voiceRecordingIdentity").classifyEvidence(
    db,
    db.prepare("SELECT * FROM voice_exemplars WHERE id = ?").get(candidate.id),
    { record: true, unavailable: "legacy_audio_unavailable" }
  );
  const unrecoverableRows = collect().rows.length;
  const profiles = f.database.getSpeakerProfiles(true, { includeProvisional: true }).length;
  assert.equal(unrecoverableRows, 0);
  assert.equal(profiles, 0);
  t.diagnostic(
    `calibration fallback: ${JSON.stringify({ pendingRows, unrecoverableRows, profiles })}`
  );
});

test("approved exemplar bytes and row survive a retention sweep past the window and restart", async (t) => {
  const f = fixture(t);
  const { candidate, playback } = await f.approve();
  const before = f.database.db
    .prepare("SELECT * FROM voice_exemplar_audio WHERE id = ?")
    .get(candidate.id);
  assert.deepEqual(f.encryption.decryptBytes(before.ciphertext), playback.wav);
  assert.equal(before.content_hash, crypto.createHash("sha256").update(playback.wav).digest("hex"));
  f.advance(4);
  f.store.enforce();
  assert.equal(f.store.status(f.noteId).state, "expired");
  f.restart();
  await f.store.legacyRecovery.done;
  const after = f.database.db
    .prepare("SELECT * FROM voice_exemplar_audio WHERE id = ?")
    .get(candidate.id);
  assert.deepEqual(after, before);
  assert.deepEqual(enrollment.play(f.database, f.store, candidate.id).wav, playback.wav);
  assert.equal(enrollment.progress(f.database, f.person.id).cleanSpans, 1);
});

test("exemplar survives re-diarisation, hard note deletion and note-id reuse", async (t) => {
  const f = fixture(t);
  const { candidate, playback } = await f.approve();
  f.database.updateNote(f.noteId, {
    transcript: JSON.stringify({
      version: 2,
      rows: [{ id: "new-diarisation-row", speaker: "speaker_9", text: "New segmentation" }],
    }),
  });
  assert.deepEqual(enrollment.play(f.database, f.store, candidate.id).wav, playback.wav);
  assert.equal(f.database.deleteNote(f.noteId).success, true);
  f.database.db.prepare("DELETE FROM notes WHERE id = ?").run(f.noteId);
  f.database.db.prepare("UPDATE sqlite_sequence SET seq = 0 WHERE name = 'notes'").run();
  const replacement = f.database.saveNote("Replacement", "", "meeting");
  assert.equal((replacement.note || replacement).id, f.noteId);
  f.store.begin(f.noteId);
  const pcm = Buffer.alloc(RATE * 2 * 5);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(Math.round(10000 * Math.sin(i / 24)), i * 2);
  f.store.append(f.noteId, "mic", pcm);
  f.store.finish(f.noteId);
  const replacementRow = {
    id: "approved-row",
    text: "A real replacement recording",
    source: "mic",
    speaker: "speaker_0",
    speakerName: "Alex",
    speakerLockSource: "user",
    suggestedProfileId: f.person.id,
    audioSpan: {
      recordingId: f.store.status(f.noteId).recordingId,
      trackId: "mic",
      startSample: 0,
      endSample: RATE * 4,
    },
  };
  f.database.updateNote(f.noteId, {
    transcript: JSON.stringify({ version: 2, rows: [replacementRow] }),
  });
  assert.equal(enrollment.listCandidates(f.database, f.store, f.person.id).length, 1);
  const other = f.database.createNamedSpeakerProfile("Other");
  const { applySpeakerCorrection } = require("../../src/helpers/speakerCorrectionTransaction");
  assert.equal(
    applySpeakerCorrection(f.database, null, {
      type: "apply",
      noteId: f.noteId,
      id: "replacement-correction",
      scope: "row",
      rowIds: [replacementRow.id],
      name: "Other",
      profileId: other.id,
    }).success,
    true
  );
  enrollment.rowCorrected(f.database.db, f.noteId, [replacementRow.id], true);
  assert.equal(
    f.database.db.prepare("SELECT valid FROM voice_exemplar_audio WHERE id = ?").get(candidate.id)
      .valid,
    1
  );
  f.restart();
  await f.store.legacyRecovery.done;
  assert.deepEqual(enrollment.play(f.database, f.store, candidate.id).wav, playback.wav);
  assert.equal(enrollment.listSamples(f.database, f.person.id)[0].permanent, true);
  assert.equal(enrollment.progress(f.database, f.person.id).cleanSpans, 1);
  assert.equal(f.database.getSpeakerProfiles(true, { includeProvisional: true }).length, 1);
  assert.equal(
    f.database.db.prepare("SELECT display_name FROM speaker_profiles WHERE id = ?").get(other.id)
      .display_name,
    "Other"
  );
});

test("playback, candidate resolution and calibration prefer approved exemplars to expired note audio", async (t) => {
  const f = fixture(t);
  const { candidate, playback } = await f.approve();
  f.advance(4);
  f.store.enforce();
  f.store.span = () => {
    throw Error("Meeting audio must not be read");
  };
  assert.deepEqual(enrollment.play(f.database, f.store, candidate.id).wav, playback.wav);
  assert.equal(enrollment.candidateReport(f.database, f.store, f.person.id).reasons.audio, 0);
  assert.equal(
    require("../../src/helpers/peopleActions").listReviewRows(f.database, f.person.id, f.store)[0]
      .eligibilityReason,
    "reviewed"
  );
  const { runJob, reportStillCurrent } = require("../../src/helpers/speakerInAppCalibration");
  const modelPath = path.join(directory, "fake-model");
  fs.writeFileSync(modelPath, "test model");
  const model = {
    isAvailable: () => true,
    getModelPath: () => modelPath,
    extractEmbeddingFromSamples: () => {
      throw Error("Approved vector must not be reconstructed");
    },
  };
  const job = { progress: { bytesRead: 0, processedRows: 0, reembeddedRows: 0 } };
  await runJob(job, f.database, f.store, { kind: "all" }, { notes: 10, rows: 10 }, model);
  assert.equal(job.state, "complete");
  assert.equal(job.report.evidence.calibrationRows, 1);
  assert.equal(job.report.evidence.exemplarRows, 1);
  assert.deepEqual(job.report.evidence.exclusions, []);
  assert.equal(job.progress.reembeddedRows, 0);
  assert.equal(await reportStillCurrent(job.report, f.database, f.store, model), true);
  f.database.deleteNote(f.noteId);
  f.database.db.prepare("DELETE FROM notes WHERE id = ?").run(f.noteId);
  assert.equal(await reportStillCurrent(job.report, f.database, f.store, model), true);
});

test("a graduated person remains matchable after every source meeting expires and is deleted", async (t) => {
  const f = fixture(t);
  await f.approve();
  f.addMeeting();
  await f.approve();
  f.addMeeting();
  await f.approve();
  assert.equal(enrollment.progress(f.database, f.person.id).usable, true);
  const before = f.database.getSpeakerProfiles(true)[0].embedding;
  f.advance(4);
  f.store.enforce();
  for (const note of f.database.db.prepare("SELECT id FROM notes").all()) {
    f.database.deleteNote(note.id);
    f.database.db.prepare("DELETE FROM notes WHERE id = ?").run(note.id);
  }
  f.restart();
  await f.store.legacyRecovery.done;
  assert.equal(enrollment.progress(f.database, f.person.id).usable, true);
  assert.deepEqual(f.database.getSpeakerProfiles(true)[0].embedding, before);
  f.database.db
    .prepare(
      "UPDATE speaker_profiles SET embedding = x'', sample_count = 0, voice_usable = 0 WHERE id = ?"
    )
    .run(f.person.id);
  assert.deepEqual(f.database.getSpeakerProfiles(true)[0].embedding, before);
  assert.equal(
    f.database.db
      .prepare("SELECT length(embedding) n FROM speaker_profiles WHERE id = ?")
      .get(f.person.id).n,
    0
  );
});

test("approval copies the proven playback bytes without reading or re-encoding the span again", async (t) => {
  const f = fixture(t);
  const [candidate] = enrollment.listCandidates(f.database, f.store, f.person.id);
  const playback = enrollment.play(f.database, f.store, candidate.id);
  f.advance(1 / 8640);
  assert.equal(
    enrollment.complete(f.database, f.store, candidate.id, playback.token).success,
    true
  );
  f.store.span = () => {
    throw Error("Span was reconstructed after playback");
  };
  f.store.codec = {
    encode: () => {
      throw Error("Re-encoded exemplar");
    },
    decode: () => {
      throw Error("Decoded exemplar");
    },
  };
  assert.equal(
    (
      await enrollment.decide(
        f.database,
        f.store,
        f.extractor,
        candidate.id,
        "approve",
        playback.token
      )
    ).success,
    true
  );
  const sample = f.database.db.prepare("SELECT * FROM voice_exemplar_audio").get();
  assert.equal(sample.recording_id, f.store.status(f.noteId).recordingId);
  assert.deepEqual(f.encryption.decryptBytes(sample.ciphertext), playback.wav);
  assert.equal(sample.revision, candidate.revision);
  assert.equal(sample.profile_id, f.person.id);
  assert.equal(sample.note_id, f.noteId);
  assert.equal(sample.row_ids, JSON.stringify(candidate.rowIds));
  assert.equal(sample.duration_ms, Math.round(candidate.durationSeconds * 1000));
  assert.equal(sample.byte_length, playback.wav.length);
  assert.equal(sample.sample_rate, 24000);
  assert.match(sample.codec, /pcm_s16le/);
  assert.ok(sample.created_at);
});

test("opening the exemplar schema preserves the existing migration version and uses only person ownership", (t) => {
  const f = fixture(t);
  const version = f.database.db.pragma("user_version", { simple: true });
  const schema = require("../../src/helpers/voiceExemplarAudio");
  f.database.db.exec("ALTER TABLE voice_exemplar_audio DROP COLUMN recording_id");
  schema.open(f.database.db);
  schema.repair(f.database.db);
  assert.ok(
    f.database.db
      .pragma("table_info(voice_exemplar_audio)")
      .some((column) => column.name === "recording_id")
  );
  assert.equal(f.database.db.pragma("user_version", { simple: true }), version);
  assert.deepEqual(
    f.database.db.pragma("foreign_key_list(voice_exemplar_audio)").map((row) => row.table),
    ["speaker_profiles"]
  );
  assert.ok(
    f.database.db
      .pragma("index_list(voice_exemplar_audio)")
      .some((index) => index.name === "idx_voice_exemplar_audio_person_row")
  );
});

test("delete person removes exemplar ciphertext and vectors without an orphan blob", async (t) => {
  const f = fixture(t);
  const { candidate } = await f.approve();
  const { applyPersonAction } = require("../../src/helpers/peopleActions");
  assert.equal(
    applyPersonAction(f.database, { type: "delete", profileId: f.person.id }).success,
    true
  );
  assert.equal(f.database.getVoiceExemplarAudio().length, 0);
  assert.equal(f.database.db.prepare("SELECT COUNT(*) n FROM voice_exemplars").get().n, 0);
  assert.equal(f.database.db.prepare("SELECT COUNT(*) n FROM speaker_profiles").get().n, 0);
  assert.equal(require("../../src/helpers/voiceExemplarAudio").sweepOrphans(f.database.db), 0);
  assert.equal(
    require("../../src/helpers/voiceExemplarAudio").play(f.database.db, f.store, candidate.id),
    null
  );
  f.restart();
  await f.store.legacyRecovery.done;
  assert.equal(f.database.getVoiceExemplarAudio().length, 0);
});

test("mixed legacy and durable spans from one recording cannot graduate or split centroid votes", async (t) => {
  const f = fixture(t);
  const doc = JSON.parse(f.database.getNote(f.noteId).transcript);
  doc.rows = [0, 5, 10].map((start, i) => ({
    ...doc.rows[0],
    id: `mixed-${i}`,
    audioSpan: {
      ...doc.rows[0].audioSpan,
      startSample: start * RATE,
      endSample: (start + 4) * RATE,
    },
  }));
  f.database.updateNote(f.noteId, { transcript: JSON.stringify(doc) });
  f.store.begin(f.noteId);
  const pcm = Buffer.alloc(RATE * 2 * 15);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(Math.round(10000 * Math.sin(i / 24)), i * 2);
  f.store.append(f.noteId, "mic", pcm);
  f.store.finish(f.noteId);
  const first = await f.approve();
  f.database.db.prepare("DELETE FROM voice_exemplar_audio WHERE id = ?").run(first.candidate.id);
  f.database.db
    .prepare("UPDATE voice_exemplars SET recording_id = NULL WHERE id = ?")
    .run(first.candidate.id);
  // Startup recovery restores an existing approval without another owner review.
  assert.equal((await enrollment.recoverLegacy(f.database, f.store).done).recovered, 1);
  f.extractor.extractEmbeddingFromSamples = async () =>
    Float32Array.from({ length: 512 }, (_, i) => (i === 0 ? 0.8 : i === 1 ? 0.6 : 0));
  await f.approve();
  await f.approve();
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(enrollment.progress(f.database, f.person.id)).filter(([key]) =>
        ["cleanSpans", "meetings", "usable"].includes(key)
      )
    ),
    { cleanSpans: 3, meetings: 1, usable: false }
  );
  t.diagnostic(
    `mixed legacy+durable: ${JSON.stringify(enrollment.progress(f.database, f.person.id))}`
  );
  f.addMeeting();
  f.extractor.extractEmbeddingFromSamples = async () =>
    Float32Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));
  await f.approve();
  assert.equal(enrollment.progress(f.database, f.person.id).usable, true);
  const embedding = enrollment.resolveProfile(f.database.db, f.person.id).embedding;
  const actual = new Float32Array(embedding.buffer, embedding.byteOffset, 512);
  const norm = Math.hypot(2.6, 1.2);
  const x = 2.6 / norm + 1,
    y = 1.2 / norm;
  assert.ok(Math.abs(actual[0] - x / Math.hypot(x, y)) < 1e-6);
  assert.ok(Math.abs(actual[1] - y / Math.hypot(x, y)) < 1e-6);

  // Remove every source of recording provenance, including the sibling lookup.
  f.database.db.exec(`UPDATE voice_exemplars SET recording_id = NULL;
    UPDATE voice_exemplar_audio SET recording_id = NULL;
    UPDATE notes SET transcript = replace(transcript, 'recordingId', 'unknownRecordingId');`);
  f.database.db.exec("DELETE FROM voice_evidence_provenance");
  const unknown = enrollment.progress(f.database, f.person.id);
  t.diagnostic(
    `unknown provenance: ${JSON.stringify({ ...unknown, vectorBytes: enrollment.resolveProfile(f.database.db, f.person.id).embedding.length })}`
  );
  assert.equal(unknown.meetings, 0);
  assert.equal(unknown.usable, false);
  assert.equal(enrollment.resolveProfile(f.database.db, f.person.id).embedding.length, 0);
  // Unresolved samples also get no centroid vote alongside a known recording.
  const known = f.database.db
    .prepare("SELECT id FROM voice_exemplar_audio WHERE note_id != ?")
    .get(f.noteId);
  f.database.db
    .prepare(
      "INSERT INTO voice_evidence_provenance (sample_id, state, recording_id) VALUES (?, 'resolved', 'known-recording')"
    )
    .run(known.id);
  const knownVector = f.database.db
    .prepare("SELECT embedding FROM voice_exemplar_audio WHERE id = ?")
    .get(known.id).embedding;
  assert.deepEqual(enrollment.resolveProfile(f.database.db, f.person.id).embedding, knownVector);
  assert.equal(enrollment.progress(f.database, f.person.id).meetings, 1);
});

for (const mapped of [false, true]) {
  test(`legacy merge ancestry is erased through reset and both undos (mapped=${mapped})`, async (t) => {
    const f = fixture(t);
    const people = require("../../src/helpers/peopleActions");
    const db = f.database.db;
    const vector = Buffer.alloc(2048, 29);
    db.prepare("UPDATE speaker_profiles SET embedding = ?, sample_count = 1 WHERE id = ?").run(
      vector,
      f.person.id
    );
    if (mapped) f.database.setSpeakerMapping(f.noteId, "speaker_0", f.person.id, "Alex");
    else f.database.updateNote(f.noteId, { transcript: null });
    const survivor = f.database.createNamedSpeakerProfile("Survivor");
    const merge = people.applyPersonAction(f.database, {
      type: "merge",
      profileId: f.person.id,
      survivorId: survivor.id,
    });
    assert.equal(merge.success, true, merge.error);
    const reset = people.applyPersonAction(f.database, { type: "reset", profileId: survivor.id });
    assert.equal(reset.success, true, reset.error);
    f.restart();
    await f.store.legacyRecovery.done;
    const undoReset = people.undoPersonAction(f.database, reset.id);
    const undoMerge = people.undoPersonAction(f.database, merge.id);
    const restored = f.database.db
      .prepare(
        "SELECT display_name, length(embedding) AS vectorBytes, sample_count FROM speaker_profiles WHERE id = ?"
      )
      .get(f.person.id);
    t.diagnostic(
      `legacy merge/reset/undo/undo: ${JSON.stringify({ mapped, merge: merge.success, reset: reset.success, undoReset: undoReset.success, undoMerge: undoMerge.success, ...restored })}`
    );
    assert.equal(undoReset.success, true, undoReset.error);
    assert.equal(undoMerge.success, true, undoMerge.error);
    assert.deepEqual(restored, { display_name: "Alex", vectorBytes: 0, sample_count: 0 });
    if (mapped)
      assert.equal(
        f.database.db
          .prepare("SELECT profile_id FROM speaker_mappings WHERE note_id = ?")
          .get(f.noteId).profile_id,
        f.person.id
      );
    assert.equal(
      f.database.db
        .prepare("SELECT length(embedding) AS n FROM speaker_profiles WHERE id = ?")
        .get(survivor.id).n,
      0
    );
  });
}

test("startup repairs c42ba9e09 removal without an older ownership snapshot when erase intent survives", async (t) => {
  const f = fixture(t);
  const { candidate } = await f.approve();
  const sample = f.database.db
    .prepare(
      `SELECT id, profile_id, note_id, track, start_sample,
    end_sample, embedding, approved_at, created_at, row_ids, meeting_date
    FROM voice_exemplar_audio WHERE id = ?`
    )
    .get(candidate.id);
  const removed = enrollment.removeSample(f.database, candidate.id);
  f.database.db
    .prepare("UPDATE voice_enrollment_actions SET before_sample = ? WHERE id = ?")
    .run(JSON.stringify({ ...sample, embedding: sample.embedding.toString("base64") }), removed.id);
  f.restart();
  await f.store.legacyRecovery.done;
  assert.equal(
    f.database.db
      .prepare("SELECT before_sample FROM voice_enrollment_actions WHERE id = ?")
      .get(removed.id).before_sample,
    null
  );
});

test("startup repairs c42ba9e09 irreversible removal snapshots and preserves reversible legacy removal", async (t) => {
  const f = fixture(t);
  const { candidate } = await f.approve();
  const db = f.database.db;
  const sample = db
    .prepare(
      `SELECT id, profile_id, note_id, track, start_sample, end_sample,
    embedding, approved_at, created_at, row_ids, meeting_date
    FROM voice_exemplar_audio WHERE id = ?`
    )
    .get(candidate.id);
  const before = JSON.stringify({ ...sample, embedding: sample.embedding.toString("base64") });
  enrollment.snapshotEvidence(db, "legacy-history", f.person.id);
  const snapshot = db
    .prepare("SELECT snapshot FROM voice_sample_action_snapshots WHERE id = 'legacy-history'")
    .get().snapshot;
  const removed = enrollment.removeSample(f.database, candidate.id);
  assert.equal(removed.success, true);
  // Seed the actual old shape: no clip, a raw before_sample vector, unavailable undo,
  // and older history still containing the removed vector. Also omit the newer column.
  db.prepare("UPDATE voice_enrollment_actions SET before_sample = ? WHERE id = ?").run(
    before,
    removed.id
  );
  db.prepare(
    "UPDATE voice_sample_action_snapshots SET snapshot = ? WHERE id = 'legacy-history'"
  ).run(snapshot);
  db.exec("ALTER TABLE voice_exemplar_audio DROP COLUMN recording_id");
  db.exec("ALTER TABLE voice_exemplars DROP COLUMN recording_id");
  const reversibleBefore = JSON.stringify({ ...JSON.parse(before), id: "other-sample" });
  db.prepare(
    "INSERT INTO voice_enrollment_actions (id, candidate_id, profile_id, note_id, choice, before_sample) VALUES ('reversible-legacy', 'other-sample', ?, ?, 'remove', ?)"
  ).run(f.person.id, f.noteId, reversibleBefore);
  require("../../src/helpers/speakerGlobalHistory").add(db, {
    id: "reversible-legacy",
    kind: "enrollment",
    profileId: f.person.id,
    noteId: f.noteId,
  });
  for (let i = 0; i < 110; i++)
    require("../../src/helpers/speakerGlobalHistory").add(db, {
      id: `ordinary-history-${i}`,
      kind: "rename",
      profileId: f.person.id,
    });
  assert.equal(
    db.prepare("SELECT 1 FROM speaker_global_actions WHERE id = ?").get(removed.id),
    undefined
  );
  // Make the reversible action the current undo point after ordinary activity.
  require("../../src/helpers/speakerGlobalHistory").add(db, {
    id: "reversible-legacy",
    kind: "enrollment",
    profileId: f.person.id,
    noteId: f.noteId,
  });
  f.restart();
  await f.store.legacyRecovery.done;
  const repaired = f.database.db
    .prepare("SELECT before_sample FROM voice_enrollment_actions WHERE id = ?")
    .get(removed.id).before_sample;
  const history = f.database.db
    .prepare("SELECT snapshot FROM voice_sample_action_snapshots WHERE id = 'legacy-history'")
    .get().snapshot;
  t.diagnostic(
    `legacy startup repair: ${JSON.stringify({ historyAdditions: 110, markerPresent: !!f.database.db.prepare("SELECT 1 FROM speaker_global_actions WHERE id = ?").get(removed.id), removedVectorRetained: repaired !== null, historicalVectorRetained: history.includes(sample.embedding.toString("base64")), liveDurableSamples: f.database.getVoiceExemplarAudio().length })}`
  );
  assert.equal(repaired, null);
  assert.equal(history.includes(sample.embedding.toString("base64")), false);
  assert.equal(
    f.database.db
      .prepare("SELECT before_sample FROM voice_enrollment_actions WHERE id = 'reversible-legacy'")
      .get().before_sample,
    reversibleBefore
  );
  assert.equal(enrollment.undo(f.database, removed.id).success, false);
  enrollment.restoreEvidence(f.database.db, "legacy-history");
  assert.equal(f.database.getVoiceExemplarAudio().length, 0);
  assert.equal(f.database.db.prepare("SELECT count(*) AS n FROM voice_exemplars").get().n, 0);
  assert.equal(enrollment.undo(f.database, "reversible-legacy").success, true);
  assert.deepEqual(
    f.database.db.prepare("SELECT embedding FROM voice_exemplars WHERE id = 'other-sample'").get()
      .embedding,
    sample.embedding
  );
  t.diagnostic(
    `reversible undo: ${JSON.stringify({ exactVectorRestored: true, vectorBytes: sample.embedding.length, historyAdditions: 110 })}`
  );
  f.restart();
  await f.store.legacyRecovery.done;
  assert.equal(
    f.database.db
      .prepare("SELECT before_sample FROM voice_enrollment_actions WHERE id = ?")
      .get(removed.id).before_sample,
    null
  );
});

test("durable-only intervals block resegmented eligibility, scanning, focused approval and calibration", async (t) => {
  const f = fixture(t);
  const doc = JSON.parse(f.database.getNote(f.noteId).transcript);
  doc.rows.push({ ...doc.rows[0], id: "new-segment-id" });
  f.database.updateNote(f.noteId, { transcript: JSON.stringify(doc) });
  const candidates = enrollment.listCandidates(f.database, f.store, f.person.id);
  const pending = candidates.find((item) => item.rowIds[0] === "new-segment-id");
  const playback = enrollment.play(f.database, f.store, pending.id);
  f.advance(1 / 8640);
  assert.equal(enrollment.complete(f.database, f.store, pending.id, playback.token).success, true);
  const approved = await f.approve();
  f.database.db.prepare("DELETE FROM voice_exemplars WHERE id = ?").run(approved.candidate.id);
  const note = f.database.getNote(f.noteId);
  const check = enrollment
    .createEligibilityContext(f.database, f.store)
    .check(note, doc.rows, doc.rows[1], f.person.id);
  assert.equal(check.reason, "reviewed");
  assert.equal(enrollment.candidateReport(f.database, f.store, f.person.id).candidates.length, 0);
  assert.equal(
    (
      await enrollment.decide(
        f.database,
        f.store,
        f.extractor,
        pending.id,
        "approve",
        playback.token
      )
    ).success,
    false
  );
  const collected = require("../../src/helpers/speakerInAppCalibration").collectRows(
    f.database,
    f.store,
    { kind: "all" },
    { notes: 1, rows: 10 }
  );
  assert.equal(collected.rows.length, 1);
  assert.equal(collected.rows[0].exemplarId, approved.candidate.id);
  assert.equal(collected.reviewedCount, 1);
});

test("clear all voice data erases exemplar blobs and vector snapshots while preserving identity, labels and action log", async (t) => {
  const f = fixture(t);
  const { candidate } = await f.approve();
  const personBefore = f.database.db.prepare("SELECT display_name FROM speaker_profiles").get();
  const transcriptBefore = f.database.getNote(f.noteId).transcript;
  const people = require("../../src/helpers/peopleActions");
  const vector = f.database.db
    .prepare("SELECT embedding FROM voice_exemplar_audio")
    .get()
    .embedding.toString("base64");
  const result = people.clearVoiceData(f.database, people.previewClearVoiceData(f.database));
  assert.equal(result.success, true);
  assert.equal(f.database.getVoiceExemplarAudio().length, 0);
  assert.equal(
    f.database.db.prepare("SELECT length(embedding) n FROM speaker_profiles").get().n,
    0
  );
  assert.equal(f.database.db.prepare("SELECT COUNT(*) n FROM note_speaker_embeddings").get().n, 0);
  assert.deepEqual(
    f.database.db.prepare("SELECT display_name FROM speaker_profiles").get(),
    personBefore
  );
  assert.equal(f.database.getNote(f.noteId).transcript, transcriptBefore);
  assert.ok(people.listPeopleActions(f.database).some((action) => action.id === result.id));
  assert.equal(
    JSON.stringify(
      f.database.db.prepare("SELECT snapshot FROM speaker_voice_clear_actions").all()
    ).includes(vector),
    false
  );
  assert.equal(
    JSON.stringify(
      f.database.db.prepare("SELECT snapshot FROM voice_sample_action_snapshots").all()
    ).includes(vector),
    false
  );
  assert.equal(require("../../src/helpers/voiceExemplarAudio").sweepOrphans(f.database.db), 0);
  assert.equal(
    require("../../src/helpers/voiceExemplarAudio").play(f.database.db, f.store, candidate.id),
    null
  );
  f.restart();
  await f.store.legacyRecovery.done;
  assert.equal(f.database.getVoiceExemplarAudio().length, 0);
  assert.equal(people.undoClearVoiceData(f.database, result.id).success, true);
  assert.equal(f.database.getVoiceExemplarAudio().length, 0);
  assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM voice_exemplars").get().n, 0);
  assert.equal(
    f.database.db.prepare("SELECT COUNT(*) AS n FROM note_speaker_embeddings").get().n,
    0
  );
  assert.equal(
    f.database.db.prepare("SELECT length(embedding) AS n FROM speaker_profiles").get().n,
    0
  );
});

test("reset then undo and older rename undo restore identity and mappings without erased biometrics", async (t) => {
  const f = fixture(t);
  const people = require("../../src/helpers/peopleActions");
  await f.approve();
  f.addMeeting();
  await f.approve();
  f.addMeeting();
  await f.approve();
  assert.equal(enrollment.progress(f.database, f.person.id).usable, true);
  f.database.setSpeakerMapping(f.noteId, "speaker_0", f.person.id, "Alex");
  f.database.db
    .prepare(
      "INSERT INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, ?, ?)"
    )
    .run(f.noteId, "speaker_0", Buffer.alloc(2048, 23));
  const vector = f.database.db
    .prepare("SELECT embedding FROM voice_exemplar_audio")
    .get()
    .embedding.toString("base64");
  const other = f.database.createNamedSpeakerProfile("Unrelated");
  f.database.db
    .prepare("UPDATE speaker_profiles SET embedding = ?, sample_count = 1 WHERE id = ?")
    .run(Buffer.alloc(2048, 19), other.id);
  assert.equal(
    people.applyPersonAction(f.database, {
      type: "rename",
      profileId: other.id,
      name: "Unrelated renamed",
    }).success,
    true
  );
  const rename = people.applyPersonAction(f.database, {
    type: "rename",
    profileId: f.person.id,
    name: "Alec",
  });
  assert.equal(rename.success, true);
  const reset = people.applyPersonAction(f.database, { type: "reset", profileId: f.person.id });
  assert.equal(reset.success, true);
  f.restart();
  await f.store.legacyRecovery.done;
  assert.equal(people.undoPersonAction(f.database, reset.id).success, true);
  assert.equal(
    f.database.db.prepare("SELECT profile_id FROM speaker_mappings WHERE note_id = ?").get(f.noteId)
      .profile_id,
    f.person.id
  );
  assert.equal(people.undoPersonAction(f.database, rename.id).success, true);
  assert.equal(
    f.database.db.prepare("SELECT display_name FROM speaker_profiles WHERE id = ?").get(f.person.id)
      .display_name,
    "Alex"
  );
  assert.equal(
    f.database.db
      .prepare("SELECT length(embedding) AS n FROM speaker_profiles WHERE id = ?")
      .get(f.person.id).n,
    0
  );
  assert.equal(f.database.getVoiceExemplarAudio().length, 0);
  assert.equal(f.database.getSpeakerProfiles(true).length, 0);
  assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM voice_exemplars").get().n, 0);
  assert.equal(
    f.database.db.prepare("SELECT COUNT(*) AS n FROM note_speaker_embeddings").get().n,
    0
  );
  assert.equal(
    JSON.stringify(
      f.database.db.prepare("SELECT snapshot FROM voice_sample_action_snapshots").all()
    ).includes(vector),
    false
  );
  assert.equal(
    f.database.db
      .prepare("SELECT embedding FROM speaker_profiles WHERE id = ?")
      .get(other.id)
      .embedding.equals(Buffer.alloc(2048, 19)),
    true
  );
  assert.equal(
    JSON.stringify(
      f.database.db
        .prepare("SELECT snapshot FROM person_identity_actions WHERE profile_id = ?")
        .all(other.id)
    ).includes(Buffer.alloc(2048, 19).toString("base64")),
    true
  );
});

test("irreversible sample removal scrubs its vector from older snapshots and cannot be undone", async (t) => {
  const f = fixture(t);
  const { candidate } = await f.approve();
  const vector = f.database.db
    .prepare("SELECT embedding FROM voice_exemplar_audio")
    .get()
    .embedding.toString("base64");
  enrollment.snapshotEvidence(f.database.db, "older-sample-history", f.person.id);
  const removed = enrollment.removeSample(f.database, candidate.id);
  assert.equal(removed.success, true);
  assert.equal(
    f.database.db
      .prepare("SELECT before_sample FROM voice_enrollment_actions WHERE id = ?")
      .get(removed.id).before_sample,
    null
  );
  assert.equal(
    JSON.stringify(
      f.database.db.prepare("SELECT snapshot FROM voice_sample_action_snapshots").all()
    ).includes(vector),
    false
  );
  assert.equal(enrollment.undo(f.database, removed.id).success, false);
  enrollment.restoreEvidence(f.database.db, "older-sample-history");
  assert.equal(f.database.getVoiceExemplarAudio().length, 0);
  assert.equal(f.database.db.prepare("SELECT COUNT(*) AS n FROM voice_exemplars").get().n, 0);
  f.restart();
  await f.store.legacyRecovery.done;
  assert.equal(
    f.database.db
      .prepare("SELECT length(embedding) AS n FROM speaker_profiles WHERE id = ?")
      .get(f.person.id).n,
    0
  );
});

for (const removeBeforeDelete of [false, true]) {
  test(`merge transfers enrollment history ownership and survivor deletion erases source historical vectors (remove first: ${removeBeforeDelete})`, async (t) => {
    const f = fixture(t);
    const { candidate } = await f.approve();
    const people = require("../../src/helpers/peopleActions");
    const vector = f.database.db
      .prepare("SELECT embedding FROM voice_exemplar_audio")
      .get()
      .embedding.toString("base64");
    const rename = people.applyPersonAction(f.database, {
      type: "rename",
      profileId: f.person.id,
      name: "Alec",
    });
    assert.equal(rename.success, true);
    const survivor = f.database.createNamedSpeakerProfile("Survivor");
    const merged = people.applyPersonAction(f.database, {
      type: "merge",
      profileId: f.person.id,
      survivorId: survivor.id,
    });
    assert.equal(merged.success, true);
    assert.equal(
      f.database.db
        .prepare("SELECT profile_id FROM voice_enrollment_actions WHERE candidate_id = ?")
        .get(candidate.id).profile_id,
      survivor.id
    );
    assert.equal(
      f.database.db
        .prepare("SELECT profile_id FROM speaker_global_actions WHERE kind = 'enrollment'")
        .get().profile_id,
      survivor.id
    );
    if (removeBeforeDelete) {
      const removed = enrollment.removeSample(f.database, candidate.id);
      assert.equal(removed.success, true);
    }
    assert.equal(
      people.applyPersonAction(f.database, { type: "delete", profileId: survivor.id }).success,
      true
    );
    assert.equal(
      f.database.db.prepare("SELECT COUNT(*) AS n FROM voice_enrollment_actions").get().n,
      0
    );
    for (const table of ["voice_sample_action_snapshots", "person_identity_actions"])
      assert.equal(
        JSON.stringify(f.database.db.prepare(`SELECT snapshot FROM ${table}`).all()).includes(
          vector
        ),
        false,
        table
      );
    assert.equal(
      JSON.stringify(f.database.db.prepare("SELECT speaker_action_log FROM notes").all()).includes(
        vector
      ),
      false
    );
    f.restart();
    await f.store.legacyRecovery.done;
    assert.equal(f.database.getVoiceExemplarAudio().length, 0);
  });
}

test("permanent ciphertext usage is separate from the recording budget and survives eviction and merge", async (t) => {
  const f = fixture(t);
  await f.approve();
  const bytes = f.database.db
    .prepare("SELECT length(ciphertext) AS n FROM voice_exemplar_audio")
    .get().n;
  assert.equal(f.store.usage().permanentAudioBytes, bytes);
  assert.equal(f.store.usage().permanentAudioCount, 1);
  const survivor = f.database.createNamedSpeakerProfile("Survivor");
  assert.equal(
    require("../../src/helpers/peopleActions").applyPersonAction(f.database, {
      type: "merge",
      profileId: f.person.id,
      survivorId: survivor.id,
    }).success,
    true
  );
  f.store.policy.budgetBytes = 0;
  f.store.enforce();
  assert.equal(f.store.usage().usedBytes, 0);
  assert.equal(f.store.usage().permanentAudioBytes, bytes);
  f.restart();
  await f.store.legacyRecovery.done;
  assert.equal(f.store.usage().permanentAudioBytes, bytes);
  const sample = f.database.getVoiceExemplarAudio()[0];
  assert.equal(enrollment.play(f.database, f.store, sample.id).state, "available");
  enrollment.removeSample(f.database, sample.id);
  assert.equal(f.store.usage().permanentAudioBytes, 0);
  assert.equal(f.store.usage().permanentAudioCount, 0);
});

test("orphan sweep on open removes an unowned encrypted exemplar blob", async (t) => {
  const f = fixture(t);
  await f.approve();
  f.database.db.pragma("foreign_keys = OFF");
  f.database.db.prepare("UPDATE voice_exemplar_audio SET profile_id = 999999").run();
  f.database.db.pragma("foreign_keys = ON");
  f.restart();
  await f.store.legacyRecovery.done;
  assert.equal(f.database.getVoiceExemplarAudio().length, 0);
});

test("missing encryption key fails approval closed with exemplar_key_unavailable and no plaintext write", async (t) => {
  const f = fixture(t);
  const [candidate] = enrollment.listCandidates(f.database, f.store, f.person.id);
  const playback = enrollment.play(f.database, f.store, candidate.id);
  f.advance(1 / 8640);
  assert.equal(
    enrollment.complete(f.database, f.store, candidate.id, playback.token).success,
    true
  );
  const original = f.encryption.encryptBytes;
  f.encryption.encryptBytes = () => {
    throw Error("Missing key");
  };
  const result = await enrollment.decide(
    f.database,
    f.store,
    f.extractor,
    candidate.id,
    "approve",
    playback.token
  );
  assert.deepEqual(result, { success: false, error: "exemplar_key_unavailable" });
  assert.equal(f.database.getVoiceExemplarAudio().length, 0);
  assert.equal(f.database.db.prepare("SELECT COUNT(*) n FROM voice_exemplars").get().n, 0);
  f.encryption.encryptBytes = original;
  assert.equal(
    (
      await enrollment.decide(
        f.database,
        f.store,
        f.extractor,
        candidate.id,
        "approve",
        playback.token
      )
    ).success,
    true
  );
  const sample = f.database.db.prepare("SELECT ciphertext FROM voice_exemplar_audio").get();
  assert.equal(sample.ciphertext.includes(playback.wav.subarray(0, 100)), false);
  f.encryption.decryptBytes = () => {
    throw Error("Lost key");
  };
  assert.deepEqual(enrollment.play(f.database, f.store, candidate.id), {
    state: "key_unavailable",
    error: "exemplar_key_unavailable",
  });
});
