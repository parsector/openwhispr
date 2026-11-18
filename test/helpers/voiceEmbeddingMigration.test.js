const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const createTempDir = require("../lib/tempDir");
let directory;
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return { app: { getPath: () => directory, getAppPath: () => process.cwd(), isReady: () => false } };
  return load.call(this, request, parent, isMain);
};
process.env.NODE_ENV = "test";
const DatabaseManager = require("../../src/helpers/database");
Module._load = load;
const enrollment = require("../../src/helpers/voiceEnrollment");
const migration = require("../../src/helpers/voiceEmbeddingMigration");
const audio = require("../../src/helpers/voiceExemplarAudio");
const { listPeople } = require("../../src/helpers/peopleActions");
const { randomUUID } = require("node:crypto");

function fixture(t) {
  directory = createTempDir(path.join(require("node:os").tmpdir(), "voice-space-"));
  const root = directory;
  const database = new DatabaseManager();
  t.after(() => { database.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const person = database.createNamedSpeakerProfile("Alex");
  const store = { encryption: require("../lib/fakeAudioEncryption") };
  const wav = Buffer.alloc(44 + 24000 * 2 * 4);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(Math.round(10000 * Math.sin(i / 24)), i);
  let calls = 0;
  const extractor = { extractEmbeddingFromSamples: async pcm => {
    assert.equal(pcm.length, 48000); calls++;
    return Float32Array.from({ length: 192 }, (_, i) => i === 0 ? 1 : 0);
  } };
  const recordings = [randomUUID(), randomUUID()];
  function clip(id, index = 0, bytes = wav) {
    const noteId = database.saveNote(id, "", "meeting").note.id;
    const recordingId = recordings[index % 2];
    audio.save(database.db, { id, profileId: person.id, noteId, recordingId, rowIds: [id], revision: "legacy-approval", track: "mic", startSample: 0, endSample: 96000, durationSeconds: 4 }, bytes, audio.seal(store, bytes), Buffer.alloc(2048, 1));
    database.db.prepare("INSERT INTO voice_evidence_provenance (sample_id, profile_id, state, recording_id) VALUES (?, ?, 'resolved', ?)").run(id, person.id, recordingId);
    return database.db.prepare("SELECT * FROM voice_exemplar_audio WHERE id=?").get(id);
  }
  return { database, person, store, extractor, clip, wav, calls: () => calls };
}

test("approved legacy clips migrate independently with consent, provenance and audit intact; rerun is inert", async t => {
  const f = fixture(t);
  const before = [f.clip("a"), f.clip("b", 1), f.clip("c")];
  await migration.migrate(f.database, f.store, { extractor: f.extractor });
  assert.equal(f.calls(), 9);
  assert.equal(enrollment.progress(f.database, f.person.id).usable, true);
  assert.equal(f.database.getSpeakerProfiles(true)[0].embedding_version, 3);
  for (const old of before) {
    const current = f.database.db.prepare("SELECT * FROM voice_exemplar_audio WHERE id=?").get(old.id);
    assert.equal(current.embedding.length, 768);
    for (const key of ["approved_at", "created_at", "profile_id", "recording_id", "content_hash"]) assert.equal(current[key], old[key]);
    assert.deepEqual(current.ciphertext, old.ciphertext);
  }
  await migration.migrate(f.database, f.store, { extractor: f.extractor });
  assert.equal(f.calls(), 9);
  assert.equal(f.database.db.prepare("SELECT count(*) n FROM voice_embedding_migrations").get().n, 3);
});

for (const problem of ["corrupt", "wrong-rate", "partial", "undecodable", "missing"]) {
  test(`unmigratable ${problem} evidence presents as not enrolled, retaining approval and recomputed needs`, async t => {
    const f = fixture(t);
    f.clip("a"); f.clip("b", 1);
    if (problem !== "missing") {
      let wav = Buffer.from(f.wav);
      if (problem === "wrong-rate") wav.writeUInt32LE(16000, 24);
      if (problem === "partial") { wav = wav.subarray(0, wav.length - 48000); }
      f.clip("c", 0, problem === "partial" ? f.wav : wav);
      if (problem === "partial") f.database.db.prepare("UPDATE voice_exemplar_audio SET ciphertext=?, byte_length=?, content_hash=? WHERE id='c'").run(audio.seal(f.store, wav), wav.length, require("node:crypto").createHash("sha256").update(wav).digest("hex"));
      if (problem === "corrupt") f.database.db.prepare("UPDATE voice_exemplar_audio SET ciphertext=x'0001' WHERE id='c'").run();
      if (problem === "undecodable") f.extractor.extractEmbeddingFromSamples = async () => null;
    } else {
      const noteId = f.database.saveNote("missing", "", "meeting").note.id;
      f.database.db.prepare("INSERT INTO voice_exemplars (id, profile_id, note_id, track, start_sample, end_sample, embedding, approved_at) VALUES ('c', ?, ?, 'mic', 0, 96000, ?, CURRENT_TIMESTAMP)").run(f.person.id, noteId, Buffer.alloc(2048, 1));
    }
    await migration.migrate(f.database, f.store, { extractor: f.extractor });
    assert.equal(f.database.getSpeakerProfiles(true).length, 0);
    const person = listPeople(f.database, f.store).find(p => p.id === f.person.id);
    assert.equal(person.hasVoice, false);
    assert.equal(person.voiceProgress.usable, false);
    assert.equal(person.voiceProgress.requiredSpans, 3);
    assert.equal(person.voiceProgress.requiredMeetings, 2);
    assert.equal(person.voiceProgress.approvedSpans, 3);
  });
}

test("interrupted midway resumes and retries previous failed attempts without duplicating successful work", async t => {
  const f = fixture(t);
  f.clip("a"); f.clip("b", 1); f.clip("c");
  let cancelled = false;
  const original = f.extractor.extractEmbeddingFromSamples;
  f.extractor.extractEmbeddingFromSamples = async pcm => { const result = await original(pcm); if (f.calls() === 4) cancelled = true; return result; };
  await migration.migrate(f.database, f.store, { extractor: f.extractor, cancelled: () => cancelled });
  assert.equal(f.database.getSpeakerProfiles(true).length, 0);
  assert.equal(f.database.db.prepare("SELECT state FROM voice_embedding_migrations WHERE sample_id='b'").get().state, "started");
  f.extractor.extractEmbeddingFromSamples = async () => { throw new Error("worker_unavailable"); };
  await migration.migrate(f.database, f.store, { extractor: f.extractor });
  assert.equal(f.database.getSpeakerProfiles(true).length, 0);
  f.extractor.extractEmbeddingFromSamples = original;
  await migration.migrate(f.database, f.store, { extractor: f.extractor });
  assert.equal(enrollment.progress(f.database, f.person.id).usable, true);
  assert.equal(f.database.db.prepare("SELECT count(*) n FROM voice_embedding_migrations WHERE sample_id='a'").get().n, 1);
  assert.equal(f.database.db.prepare("SELECT count(*) n FROM voice_embedding_migrations WHERE state='migrated'").get().n, 3);
});

test("migration audit follows explicit exemplar ownership changes and survives merging away the source person", async t => {
  const f = fixture(t);
  f.clip("owned");
  await migration.migrate(f.database, f.store, { extractor: f.extractor });
  const survivor = f.database.createNamedSpeakerProfile("Survivor");
  f.database.db.prepare("UPDATE voice_exemplar_audio SET profile_id=? WHERE id='owned'").run(survivor.id);
  f.database.db.prepare("DELETE FROM speaker_profiles WHERE id=?").run(f.person.id);
  const audit = f.database.db.prepare("SELECT * FROM voice_embedding_migrations WHERE sample_id='owned'").get();
  assert.ok(audit, "merging a person must preserve the migration audit for retained evidence");
  assert.equal(audit.profile_id, survivor.id);
  assert.equal(audit.state, "migrated");
});

test("a converted legacy person stays not enrolled until current evidence satisfies graduation", async t => {
  const f = fixture(t);
  f.clip("only-retained-clip");
  await migration.migrate(f.database, f.store, { extractor: f.extractor });
  const person = listPeople(f.database, f.store).find(p => p.id === f.person.id);
  assert.equal(person.hasVoice, false);
  assert.equal(person.voiceProgress.usable, false);
  assert.equal(person.voiceProgress.cleanSpans, 1);
  assert.equal(f.database.getSpeakerProfiles(true, { includeProvisional: true }).length, 0);
});
