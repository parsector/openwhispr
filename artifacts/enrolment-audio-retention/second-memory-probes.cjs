// Isolated reproductions using the real DatabaseManager and action modules.
// SQLite opens are redirected to :memory:; no production state is accessed.
const assert = require("node:assert/strict");
const Module = require("node:module");
const Sqlite = require("better-sqlite3");
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "better-sqlite3")
    return function () {
      return new Sqlite(":memory:");
    };
  if (request === "electron")
    return {
      app: { getPath: () => __dirname, getAppPath: () => process.cwd(), isReady: () => false },
    };
  return load.call(this, request, parent, isMain);
};
process.env.NODE_ENV = "test";
const DatabaseManager = require("../../src/helpers/database");
const enrollment = require("../../src/helpers/voiceEnrollment");
const audio = require("../../src/helpers/voiceExemplarAudio");
const people = require("../../src/helpers/peopleActions");
const { recordingIdentity } = require("../../src/helpers/voiceRecordingIdentity");
const vector = Buffer.from(Float32Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)).buffer);

const database = new DatabaseManager();
const db = database.db;
assert.equal(db.name, ":memory:");
const person = database.createNamedSpeakerProfile("Alex");
const noteA = database.saveNote("A", "", "meeting").note.id;
const noteB = database.saveNote("B", "", "meeting").note.id;
const rows = [0, 1, 2].map((i) => ({
  id: `row-${i}`,
  speaker: "speaker_0",
  speakerName: "Alex",
  speakerLockSource: "user",
  suggestedProfileId: person.id,
  audioSpan: {
    recordingId: "recording-A",
    trackId: "mic",
    startSample: i * 120000,
    endSample: i * 120000 + 96000,
  },
}));
database.updateNote(noteA, { transcript: JSON.stringify({ version: 2, rows }) });
db.prepare(
  `INSERT INTO voice_exemplars
  (id, profile_id, note_id, row_ids, track, start_sample, end_sample, embedding, approved_at)
  VALUES ('legacy', ?, ?, '["row-0"]', 'mic', 0, 96000, ?, CURRENT_TIMESTAMP)`
).run(person.id, noteA, vector);
for (const i of [1, 2])
  audio.save(
    db,
    {
      id: `durable-${i}`,
      profileId: person.id,
      noteId: noteA,
      recordingId: "recording-A",
      rowIds: [`row-${i}`],
      revision: "probe",
      track: "mic",
      startSample: i * 120000,
      endSample: i * 120000 + 96000,
      durationSeconds: 4,
      meetingDate: null,
    },
    Buffer.from("wav"),
    Buffer.from("ciphertext"),
    vector
  );
const summary = () => {
  const { cleanSpans, meetings, usable } = enrollment.progress(database, person.id);
  return { cleanSpans, meetings, usable };
};
console.log(`mixed legacy+durable: ${JSON.stringify(summary())}`);
assert.deepEqual(summary(), { cleanSpans: 3, meetings: 1, usable: false });
db.exec(`UPDATE voice_exemplars SET recording_id = NULL;
  UPDATE voice_exemplar_audio SET recording_id = NULL;
  UPDATE notes SET transcript = replace(transcript, 'recordingId', 'unknownRecordingId');`);
db.prepare(
  "UPDATE voice_exemplar_audio SET note_id = ?, note_identity = (SELECT client_note_id FROM notes WHERE id = ?) WHERE id = 'durable-2'"
).run(noteB, noteB);
const identities = database.getVoiceExemplarAudio().map((sample) => recordingIdentity(db, sample));
const unknown = {
  identities,
  ...summary(),
  vectorBytes: enrollment.resolveProfile(db, person.id).embedding.length,
};
console.log(`unknown provenance: ${JSON.stringify(unknown)}`);
assert.deepEqual(unknown, {
  identities: [null, null],
  cleanSpans: 3,
  meetings: 0,
  usable: false,
  vectorBytes: 0,
});
db.close();

const legacy = new DatabaseManager();
const source = legacy.createNamedSpeakerProfile("Alex");
const survivor = legacy.createNamedSpeakerProfile("Survivor");
legacy.db
  .prepare("UPDATE speaker_profiles SET embedding = ?, sample_count = 1 WHERE id = ?")
  .run(vector, source.id);
const noteId = legacy.saveNote("Legacy", "", "meeting").note.id;
legacy.setSpeakerMapping(noteId, "speaker_0", source.id, "Alex");
const merge = people.applyPersonAction(legacy, {
  type: "merge",
  profileId: source.id,
  survivorId: survivor.id,
});
const reset = people.applyPersonAction(legacy, { type: "reset", profileId: survivor.id });
const undoReset = people.undoPersonAction(legacy, reset.id);
const undoMerge = people.undoPersonAction(legacy, merge.id);
const restored = legacy.db
  .prepare(
    "SELECT display_name, length(embedding) AS vectorBytes, sample_count FROM speaker_profiles WHERE id = ?"
  )
  .get(source.id);
const mappingRestored =
  legacy.db.prepare("SELECT profile_id FROM speaker_mappings WHERE note_id = ?").get(noteId)
    ?.profile_id === source.id;
console.log(
  `legacy merge/reset/undo/undo: ${JSON.stringify({ merge: merge.success, reset: reset.success, undoReset: undoReset.success, undoMerge: undoMerge.success, ...restored, mappingRestored })}`
);
assert.equal(merge.success && reset.success && undoReset.success && undoMerge.success, true);
assert.deepEqual(restored, { display_name: "Alex", vectorBytes: 0, sample_count: 0 });
assert.equal(mappingRestored, true);
legacy.db.close();
