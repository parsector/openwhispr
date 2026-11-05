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
    .prepare("UPDATE voice_exemplar_audio SET recording_id = 'known-recording' WHERE id = ?")
    .run(known.id);
  const knownVector = f.database.db
    .prepare("SELECT embedding FROM voice_exemplar_audio WHERE id = ?")
    .get(known.id).embedding;
  assert.deepEqual(enrollment.resolveProfile(f.database.db, f.person.id).embedding, knownVector);
  assert.equal(enrollment.progress(f.database, f.person.id).meetings, 1);
});

for (const mapped of [false, true]) {
  test(`legacy merge ancestry is erased through reset and both undos (mapped=${mapped})`, (t) => {
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
  f.restart();
  const repaired = f.database.db
    .prepare("SELECT before_sample FROM voice_enrollment_actions WHERE id = ?")
    .get(removed.id).before_sample;
  const history = f.database.db
    .prepare("SELECT snapshot FROM voice_sample_action_snapshots WHERE id = 'legacy-history'")
    .get().snapshot;
  t.diagnostic(
    `legacy startup repair: ${JSON.stringify({ removedVectorRetained: repaired !== null, historicalVectorRetained: history.includes(sample.embedding.toString("base64")), liveDurableSamples: f.database.getVoiceExemplarAudio().length })}`
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
  f.restart();
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
