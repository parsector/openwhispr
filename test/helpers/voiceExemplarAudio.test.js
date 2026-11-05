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

function fixture(t) {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "exemplar-"));
  const root = directory;
  let database = new DatabaseManager();
  let clock = Date.now();
  const key = crypto.randomBytes(32);
  const encryption = {
    encryptBytes(bytes) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
    },
    decryptBytes(bytes) {
      const cipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]);
    },
  };
  const makeStore = () =>
    new MeetingAudioStore(path.join(root, "recordings"), {
      database,
      encryption,
      codec,
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
  f.restart();
  assert.deepEqual(enrollment.play(f.database, f.store, candidate.id).wav, playback.wav);
  assert.equal(enrollment.listSamples(f.database, f.person.id)[0].permanent, true);
  assert.equal(enrollment.progress(f.database, f.person.id).cleanSpans, 1);
  assert.equal(f.database.getSpeakerProfiles(true, { includeProvisional: true }).length, 1);
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
  schema.open(f.database.db);
  schema.repair(f.database.db);
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
  assert.equal(f.database.getVoiceExemplarAudio().length, 0);
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
  assert.equal(f.database.getVoiceExemplarAudio().length, 0);
});

test("orphan sweep on open removes an unowned encrypted exemplar blob", async (t) => {
  const f = fixture(t);
  await f.approve();
  f.database.db.pragma("foreign_keys = OFF");
  f.database.db.prepare("UPDATE voice_exemplar_audio SET profile_id = 999999").run();
  f.database.db.pragma("foreign_keys = ON");
  f.restart();
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
