const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const createTempDir = require("../lib/tempDir");
let dir;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron")
    return { app: { getPath: () => dir, getAppPath: () => process.cwd(), isReady: () => false } };
  return originalLoad.call(this, request, parent, isMain);
};
process.env.NODE_ENV = "test";
const Database = require("../../src/helpers/database");
const {
  readScope,
  decision,
  enforceRows,
  profileFingerprint,
} = require("../../src/helpers/noteSpeakerScope");
const { mayAutoName, candidateSetEvidence } = require("../../src/helpers/speakerRosterPolicy");
const {
  readTranscriptDocument,
  writeTranscriptDocument,
} = require("../../src/helpers/transcriptDocument");
const { applySpeakerCorrection } = require("../../src/helpers/speakerCorrectionTransaction");
Module._load = originalLoad;
function fixture(t) {
  dir = createTempDir(path.join(os.tmpdir(), "ow-roster-"));
  const ownDir = dir;
  const db = new Database();
  t.after(() => {
    db.db.close();
    fs.rmSync(ownDir, { recursive: true, force: true });
  });
  const a = db.createNamedSpeakerProfile("Alex", "a@example.com");
  const c = db.createNamedSpeakerProfile("Alex", "c@example.com");
  const noteId = db.saveNote("Current", "", "meeting").note.id;
  db.updateNote(noteId, { participants: JSON.stringify([{ email: "a@example.com" }]) });
  const profile = {
    ...a,
    voice_usable: 1,
    embedding: Buffer.from(new Float32Array([1, 0, 0]).buffer),
  };
  const scope = readScope(db, noteId);
  const evidence = decision(scope, {
    runId: "run",
    path: "fixture",
    profile,
    profiles: [profile],
    scores: { best: 1 },
  });
  const row = {
    id: "row",
    text: "Hello",
    source: "system",
    speaker: "speaker_0",
    speakerName: "Alex",
    speakerDecision: evidence,
    diarizationRunId: "run",
  };
  assert.equal(db.updateNote(noteId, { transcript: writeTranscriptDocument([row]) }).success, true);
  return {
    db,
    a,
    c,
    profile,
    noteId,
    row,
    scope,
    evidence,
    rows: () => readTranscriptDocument(db.getNote(noteId).transcript).rows,
  };
}
test("roster revision invalidates a delayed renderer save after remove then re-add and resumed recording", (t) => {
  const f = fixture(t);
  const stale = f.db.getNote(f.noteId).transcript;
  f.db.updateNote(f.noteId, { participants: JSON.stringify([{ email: "c@example.com" }]) });
  assert.equal(f.rows()[0].speakerName, undefined);
  f.db.updateNote(f.noteId, { participants: JSON.stringify([{ email: "a@example.com" }]) });
  assert.notEqual(readScope(f.db, f.noteId).revision, f.scope.revision);
  assert.equal(
    f.db.updateNote(f.noteId, { transcript: stale }, { reconcileTranscript: true }).success,
    true
  );
  assert.equal(f.rows()[0].speakerName, undefined);
  const fresh = {
    ...f.row,
    id: "resumed",
    diarizationRunId: "run-2",
    speakerDecision: decision(readScope(f.db, f.noteId), {
      runId: "run-2",
      path: "live",
      profile: f.profile,
      profiles: [f.profile],
    }),
  };
  f.db.updateNote(f.noteId, { transcript: writeTranscriptDocument([...f.rows(), fresh]) });
  assert.equal(f.rows()[1].speakerName, "Alex");
});
test("roster changed by sync or a linked event cannot resurrect a recorded name on read", (t) => {
  const f = fixture(t);
  f.db.db
    .prepare("UPDATE notes SET participants = ? WHERE id = ?")
    .run(JSON.stringify([{ email: "c@example.com" }]), f.noteId);
  assert.equal(f.rows()[0].speakerName, undefined);
});
test("roster resolver and decisions create no attendance, contacts, profiles or training evidence", (t) => {
  const f = fixture(t);
  const tables = [
    "person_attendance",
    "contacts",
    "speaker_profiles",
    "voice_exemplars",
    "voice_exemplar_audio",
    "voice_enrollment_candidates",
  ];
  const counts = () =>
    tables.map((table) => f.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  const before = counts();
  f.db.updateNote(f.noteId, {
    participants: JSON.stringify([
      { email: "new@example.com", displayName: "New" },
      { displayName: "Alex", profileId: f.a.id },
    ]),
  });
  assert.deepEqual(readScope(f.db, f.noteId).eligibleProfileIds, []);
  enforceRows(f.db, f.noteId, [{ ...f.row }], { includeUnrecorded: true });
  assert.deepEqual(counts(), before);
});
test("roster predicate keeps all human locks, ambiguity, duration, overlap and approval gates", (t) => {
  const f = fixture(t);
  assert.equal(mayAutoName({}, f.profile, f.scope, { acousticAccepted: true }), true);
  for (const row of [
    { speakerLocked: true },
    { speakerLockSource: "user" },
    { speakerStatus: "locked" },
    { speakerStatus: "user_locked" },
    { overlap: true },
    ...[
      "too_short",
      "close_match",
      "not_sure",
      "overlapping_speech",
      "possible_mixed_speakers",
    ].map((reason) => ({ uncertainty: { reason } })),
  ])
    assert.equal(mayAutoName(row, f.profile, f.scope, { acousticAccepted: true }), false);
  assert.equal(
    mayAutoName({}, { ...f.profile, voice_usable: 0 }, f.scope, { acousticAccepted: true }),
    false
  );
  assert.equal(mayAutoName({}, f.profile, f.scope, { acousticAccepted: false }), false);
  assert.equal(
    mayAutoName({}, f.profile, f.scope, { acousticAccepted: true, currentRevision: "stale" }),
    false
  );
});
test("roster row correction permits outsider and Unknown only in the corrected scope, then undo obeys the current roster", (t) => {
  const f = fixture(t);
  f.db.updateNote(f.noteId, {
    transcript: writeTranscriptDocument([f.row, { ...f.row, id: "other", speaker: "speaker_1" }]),
  });
  const named = applySpeakerCorrection(f.db, null, {
    type: "apply",
    id: "manual",
    noteId: f.noteId,
    scope: "row",
    rowIds: ["row"],
    name: "Outsider",
    profileId: f.c.id,
  });
  assert.equal(named.success, true);
  assert.equal(f.rows()[0].speakerName, "Outsider");
  assert.equal(f.rows()[1].speakerName, "Alex");
  f.db.updateNote(f.noteId, { participants: JSON.stringify([{ email: "other@example.com" }]) });
  assert.equal(f.rows()[0].speakerName, "Outsider");
  assert.equal(f.rows()[1].speakerName, undefined);
  assert.equal(
    applySpeakerCorrection(f.db, null, { type: "undo", noteId: f.noteId, id: "manual" }).success,
    true
  );
  assert.equal(f.rows()[0].speakerName, undefined);
});
test("roster missing lookup fails closed and historical evidence is explicitly unrecorded", () => {
  const scope = readScope(
    {
      getNote: () => {
        throw Error("offline");
      },
    },
    42
  );
  assert.deepEqual(scope.eligibleProfileIds, []);
  assert.equal(scope.failure, "note_missing");
  assert.deepEqual(candidateSetEvidence({ speakerName: "Legacy" }), {
    candidateSetStatus: "not_recorded",
  });
  assert.equal(profileFingerprint({}), null);
});

test("linked event replacement, removal and restoration each invalidate fallback decisions", (t) => {
  const f = fixture(t);
  const event = {
    id: "linked",
    calendar_id: "calendar",
    start_time: "2026-11-10T10:00:00Z",
    end_time: "2026-11-10T11:00:00Z",
    attendees: JSON.stringify([{ email: "a@example.com" }]),
  };
  f.db.upsertCalendarEvents([event]);
  f.db.updateNote(f.noteId, { participants: null, calendar_event_id: event.id });
  const original = readScope(f.db, f.noteId);
  f.db.upsertCalendarEvents([
    { ...event, attendees: JSON.stringify([{ email: "c@example.com" }]) },
  ]);
  f.db.upsertCalendarEvents([event]);
  const restored = readScope(f.db, f.noteId);
  assert.notEqual(original.revision, restored.revision);
  f.db.upsertCalendarEvents([event]);
  assert.equal(
    readScope(f.db, f.noteId).revision,
    restored.revision,
    "identical sync is not an edit"
  );
  f.db.db.prepare("DELETE FROM calendar_events WHERE id = ?").run(event.id);
  f.db.upsertCalendarEvents([event]);
  assert.notEqual(readScope(f.db, f.noteId).revision, restored.revision);
});

test("a read-time veto remains stable for optimistic final saves after sync edits", (t) => {
  const f = fixture(t);
  f.db.db
    .prepare("UPDATE notes SET participants = ? WHERE id = ?")
    .run(JSON.stringify([{ email: "c@example.com" }]), f.noteId);
  const observed = f.db.getNote(f.noteId).transcript;
  assert.equal(f.db.getNote(f.noteId).transcript, observed);
  assert.equal(
    f.db.updateNote(
      f.noteId,
      { transcript: observed },
      { expectedTranscript: observed, reconcileTranscript: true }
    ).success,
    true
  );
  assert.equal(f.rows()[0].speakerName, undefined);
});
