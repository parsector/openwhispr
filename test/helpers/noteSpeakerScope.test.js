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
  publicTranscript,
  reconcileCloudTranscript,
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
test('portable machine identity is revalidated on import and on later participant edits', (t) => {
  const f = fixture(t);
  const remoteProfile = { id: 900, email: ' C@EXAMPLE.COM ', voice_usable: 1, embedding: [1, 0] };
  const remoteScope = require('../../src/helpers/speakerRosterPolicy').resolveSpeakerRoster({ id: 999, participants: '[]' }, null, [remoteProfile]);
  const remote = { id: 'remote', text: 'hello', speakerName: 'C', speakerDecision: decision(remoteScope, { path: 'live', profile: remoteProfile }) };
  const cloud = publicTranscript(writeTranscriptDocument([remote]));
  assert.equal(cloud.includes('900'), false, 'local numeric identities must not cross sync');
  const imported = reconcileCloudTranscript(cloud, null).transcript;
  f.db.updateNote(f.noteId, { participants: '[]', transcript: imported });
  assert.equal(f.rows()[0].speakerName, 'C');
  const localProfileId = f.rows()[0].speakerDecision?.acceptedProfileId;
  f.db.updateNote(f.noteId, { participants: JSON.stringify([{ email: 'a@example.com' }]) });
  assert.equal(f.rows()[0].speakerName, undefined);
  assert.equal(localProfileId, f.c.id);
  assert.ok(f.rows()[0].speakerDecision.rejectionReason);
});

test('portable human choices, including Unknown, survive import and participant edits', (t) => {
  const f = fixture(t);
  for (const name of ['Human outsider', undefined]) {
    const raw = publicTranscript(writeTranscriptDocument([{ id: 'human', text: 'hello', speakerName: name, speakerIsPlaceholder: !name, speakerStatus: 'user_locked' }]));
    f.db.updateNote(f.noteId, { transcript: reconcileCloudTranscript(raw, null).transcript });
    f.db.updateNote(f.noteId, { participants: JSON.stringify([{ email: 'nobody@example.com' }]) });
    assert.equal(require('../../src/helpers/speakerRosterPolicy').humanProtected(f.rows()[0]), true);
    assert.equal(f.rows()[0].speakerName, name);
  }
});

test('cloud upsert scopes imported machine names before returning the note to IPC', (t) => {
  const f = fixture(t);
  const imported = f.db.upsertNoteFromCloud({
    id: 'remote-cloud', client_note_id: 'remote-client', title: 'Remote', content: '',
    note_type: 'meeting', participants: JSON.stringify([{ email: 'a@example.com' }]),
    created_at: '2026-11-10T00:00:00Z', updated_at: '2026-11-10T00:00:00Z',
    transcript: writeTranscriptDocument([{ id: 'remote', text: 'hello', speakerName: 'C',
      speakerAssignment: { origin: 'machine', accepted: true, email: 'c@example.com' } }]),
  }, null);
  const row = readTranscriptDocument(imported.transcript).rows[0];
  assert.equal(row.speakerName, undefined);
  assert.equal(row.speakerDecision.rejectionReason, 'outside_roster');
  assert.equal(readTranscriptDocument(f.db.getNoteByCloudId('remote-cloud').transcript).rows[0].speakerName, undefined);
});

test('imported machine identities fail closed when missing, ambiguous, or unreadable', () => {
  for (const profiles of [[], [{ id: 1, email: 'c@example.com' }, { id: 2, email: 'C@example.com' }], null]) {
    const row = { id: 'row', speakerName: 'C', speakerAssignment: { origin: 'machine', accepted: true, email: 'c@example.com' } };
    const db = { getNote: () => ({ id: 42, participants: '[]' }), getSpeakerProfiles: () => { if (!profiles) throw Error('offline'); return profiles; } };
    enforceRows(db, 42, [row]);
    assert.equal(row.speakerName, undefined);
    assert.equal(row.speakerDecision.rejectionReason, 'identity_unresolved');
  }
});

test('calendar-only edits preserve existing machine evidence across the policy upgrade', (t) => {
  const f = fixture(t);
  const legacy = { ...f.evidence, linkedEventId: 'before', revision: JSON.stringify([
    f.scope.rosterRevision, f.scope.source, f.scope.rawRoster, 'before', null, f.scope.eligibleProfileIds,
  ]) };
  f.db.db.prepare('UPDATE notes SET transcript = ?, calendar_event_id = ? WHERE id = ?')
    .run(writeTranscriptDocument([{ ...f.row, speakerDecision: legacy }]), 'after', f.noteId);
  assert.equal(f.rows()[0].speakerName, 'Alex');
  assert.deepEqual(f.rows()[0].speakerDecision, legacy, 'the original acoustic evidence stays intact');
});

test('legacy calendar-scoped acceptance remains valid when NULL becomes unrestricted', (t) => {
  const f = fixture(t);
  f.db.updateNote(f.noteId, { participants: null });
  const scope = readScope(f.db, f.noteId);
  const legacy = { ...f.evidence, source: 'linked_event', rosterRevision: scope.rosterRevision,
    revision: JSON.stringify([scope.rosterRevision, 'linked_event', f.scope.rawRoster, 'before', null, [f.a.id]]) };
  f.db.db.prepare('UPDATE notes SET transcript = ? WHERE id = ?')
    .run(writeTranscriptDocument([{ ...f.row, speakerDecision: legacy }]), f.noteId);
  assert.equal(f.rows()[0].speakerName, 'Alex');
  f.db.updateNote(f.noteId, { participants: JSON.stringify([{ email: 'c@example.com' }]) });
  assert.equal(f.rows()[0].speakerName, undefined);
});
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

test("calendar edits, replacement and relinking do not invalidate NULL participant scope", (t) => {
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
  assert.equal(original.revision, restored.revision);
  f.db.upsertCalendarEvents([event]);
  assert.equal(
    readScope(f.db, f.noteId).revision,
    restored.revision,
    "identical sync is not an edit"
  );
  f.db.db.prepare("DELETE FROM calendar_events WHERE id = ?").run(event.id);
  f.db.upsertCalendarEvents([event]);
  assert.equal(readScope(f.db, f.noteId).revision, restored.revision);
  f.db.updateNote(f.noteId, { calendar_event_id: null });
  assert.equal(readScope(f.db, f.noteId).revision, restored.revision);
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

for (const alteration of ["track", "recording", "sample", "profile", "content", "genuine"]) {
  test(`row supersession requires canonical audio and current profile: ${alteration}`, (t) => {
    const f = fixture(t);
    f.db.getSpeakerProfiles = () => [f.profile];
    const veto = {
      ...f.evidence,
      decisionId: "vetoed",
      acceptedProfileId: null,
      rejectionReason: "no_match",
    };
    const row = {
      ...f.row,
      speakerName: undefined,
      speakerIsPlaceholder: true,
      audioContentHash: "canonical",
      speakerDecision: veto,
      audioSpan: { recordingId: 1, trackId: "system", startSample: 0, endSample: 96000 },
    };
    const incoming = {
      ...row,
      speakerName: "Alex",
      speakerIsPlaceholder: false,
      speakerDecision: { ...f.evidence, decisionId: "evaluated" },
    };
    if (alteration === "track") incoming.audioSpan = { ...row.audioSpan, trackId: "mic" };
    if (alteration === "recording") incoming.audioSpan = { ...row.audioSpan, recordingId: 2 };
    if (alteration === "sample") incoming.audioSpan = { ...row.audioSpan, endSample: 95999 };
    if (["genuine", "profile", "content"].includes(alteration))
      incoming.speakerDecision.evaluation = {
        rowId: row.id,
        previousDecisionId: veto.decisionId,
        audioContentHash: alteration === "content" ? "other" : "canonical",
        rosterRevision: f.scope.rosterRevision,
        revision: f.scope.revision,
        profileFingerprint:
          alteration === "profile" ? "old-profile" : profileFingerprint(f.profile),
      };
    const [actual] = enforceRows(f.db, f.noteId, [incoming], { storedRows: [row] });
    assert.equal(actual.speakerName, undefined, "plain-data evaluation is never authority");
    assert.equal(require("../../src/helpers/speakerRosterPolicy").humanProtected(actual), false);
  });
}

test('a new automatic row keeps its current scope through optimistic transcript reconciliation',t=>{
  const f=fixture(t);
  const row={...f.row,id:'a692b24f-a0d4-4d62-a39c-c915dd099cf9',text:'a replacement transcription'};
  const previous=f.db.getNote(f.noteId).transcript;
  assert.equal(f.db.updateNote(f.noteId,{transcript:writeTranscriptDocument([row])},{expectedTranscript:previous,reconcileTranscript:true}).success,true);
  assert.equal(f.rows().find(r=>r.id===row.id).speakerName,'Alex');
});

test("run7: identity-only import carries unevaluated provenance through roster refusal", (t) => {
  const f = fixture(t);
  const imported = {
    id: "imported",
    text: "hello",
    source: "system",
    speakerName: "Alex",
    speakerAssignment: {
      origin: "machine",
      email: "a@example.com",
      accepted: true,
    },
  };
  const [installed] = enforceRows(f.db, f.noteId, [imported]);
  assert.equal(installed.speakerDecision.acceptedProfileId, f.a.id);
  assert.equal(installed.speakerDecision.acousticEvaluation, "not_evaluated");
  assert.equal(installed.speakerDecision.candidateSetStatus, "not_recorded");
  f.db.db
    .prepare("UPDATE notes SET transcript = ? WHERE id = ?")
    .run(writeTranscriptDocument([installed]), f.noteId);
  assert.equal(
    f.db.updateNote(f.noteId, { participants: '[{"email":"c@example.com"}]' }).success,
    true
  );
  const refused = f.rows()[0];
  assert.equal(refused.speakerName, undefined);
  assert.equal(refused.speakerDecision.rejectionReason, "roster_changed");
  assert.equal(refused.speakerDecision.acousticEvaluation, "not_evaluated");
  assert.equal(refused.speakerDecision.candidateSetStatus, "not_recorded");
  assert.equal(refused.speakerDecision.modelFingerprint, null);
  assert.equal(refused.speakerDecision.acousticWinnerProfileId, null);
});
