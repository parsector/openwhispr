const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-sync-db-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");
const loadGuards = () => import("../../src/helpers/cloudSyncGuards.js");
const { skipOrFail } = require("./harness/db.js");

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-sync-db-"));
  try {
    const BetterSqlite = require("better-sqlite3");
    const probe = new BetterSqlite(path.join(userDataDir, "probe.db"));
    probe.close();
    fs.rmSync(path.join(userDataDir, "probe.db"), { force: true });
  } catch (error) {
    skipOrFail(t, error);
    return null;
  }

  try {
    return new DatabaseManager();
  } catch (error) {
    skipOrFail(t, error);
    return null;
  }
}

// Regression for #1290: a meeting note is created as an empty shell locally and
// in the cloud, the user's transcript and notes are saved locally, and a sync
// pull elects the still-empty cloud shell (its ISO timestamp lexically beats
// the local SQLite-format timestamp) and overwrites the local edit wholesale.

const TRANSCRIPT = JSON.stringify([{ text: "T".repeat(70000), source: "system", timestamp: 1 }]);

// The shell exactly as meetingDetectionEngine creates it, then the user's edit
// via the real save path. Returns the edited local row (sync_status pending,
// SQLite-format updated_at).
function seedEditedMeetingNote(db) {
  const saved = db.saveNote("Gabriel / Joshua", "", "meeting");
  const shell = saved.note || saved;
  db.updateNote(shell.id, {
    title: "Vision, Values, and Product Priorities",
    content: "REAL MEETING NOTES",
    enhanced_content: "ENHANCED NOTES",
    enhancement_prompt: "summarize the meeting",
    enhancement_template_id: "notes.actions.builtin.detailedNotes",
    enhanced_at_content_hash: "hash-of-real-notes",
    transcript: TRANSCRIPT,
    cloud_id: "cloud-test-1",
  });
  return db.getNote(shell.id);
}

// The cloud's copy: the empty shell, stamped at the local edit's UTC midnight
// — older in real time (same instant at worst, if the edit lands exactly at
// 00:00:00) but with an ISO timestamp ('T' at index 10) that lexically beats
// the local SQLite format (' ' at index 10).
function emptyCloudShell(local) {
  const today = local.updated_at.slice(0, 10);
  return {
    id: "cloud-test-1",
    client_note_id: local.client_note_id,
    title: "Gabriel / Joshua",
    content: "",
    enhanced_content: null,
    transcript: null,
    note_type: "meeting",
    folder_id: null,
    source_file: null,
    audio_duration_seconds: null,
    enhancement_prompt: null,
    enhanced_at_content_hash: null,
    participants: JSON.stringify([{ email: "test@example.com" }]),
    calendar_event_id: "cal-ev-1",
    diarization_enabled: null,
    expected_speaker_count: null,
    deleted_at: null,
    created_at: `${today}T00:00:00.000Z`,
    updated_at: `${today}T00:00:00.000Z`,
  };
}

test("pull gate: an hours-older empty cloud shell is not elected over a fresh local edit", async (t) => {
  const db = createDb(t);
  if (!db) return;

  const local = seedEditedMeetingNote(db);
  assert.match(
    local.updated_at,
    /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/,
    "premise: local edits carry SQLite-format updated_at"
  );
  assert.equal(local.sync_status, "pending");

  const cloudNote = emptyCloudShell(local);
  assert.equal(
    cloudNote.updated_at > local.updated_at,
    true,
    "premise: the raw lexical compare would elect the hours-older cloud shell"
  );

  const { isCloudEntryNewer } = await loadGuards();
  assert.equal(
    isCloudEntryNewer(cloudNote.updated_at, local.updated_at),
    false,
    "the normalized pull gate must not elect the hours-older empty cloud shell"
  );
});

test("upsertNoteFromCloud: empty cloud values never destroy non-empty local content", (t) => {
  const db = createDb(t);
  if (!db) return;

  const before = seedEditedMeetingNote(db);
  db.upsertNoteFromCloud(emptyCloudShell(before), null);
  const after = db.getNote(before.id);

  assert.equal(after.content, "REAL MEETING NOTES", "content must survive an empty cloud copy");
  assert.equal(after.transcript, before.transcript, "transcript must survive an empty cloud copy");
  assert.equal(
    after.enhanced_content,
    "ENHANCED NOTES",
    "enhanced_content must survive an empty cloud copy"
  );
  assert.equal(
    after.enhancement_prompt,
    "summarize the meeting",
    "enhancement_prompt must travel with the preserved enhanced_content"
  );
  assert.equal(
    after.enhancement_template_id,
    "notes.actions.builtin.detailedNotes",
    "the template id must travel with the preserved enhanced_content"
  );
  assert.equal(
    after.enhanced_at_content_hash,
    "hash-of-real-notes",
    "enhanced_at_content_hash must travel with the preserved enhanced_content (staleness detection breaks without it)"
  );
  assert.ok(after.participants, "participants still preserved (COALESCE)");
  assert.equal(after.calendar_event_id, "cal-ev-1", "calendar_event_id still preserved (COALESCE)");
});

test("upsertNoteFromCloud: non-empty cloud text updates and local-only transcript rows survive", (t) => {
  const db = createDb(t);
  if (!db) return;

  const before = seedEditedMeetingNote(db);
  const cloudNote = {
    ...emptyCloudShell(before),
    title: "Cloud Title",
    content: "CLOUD EDIT",
    enhanced_content: "CLOUD ENHANCED",
    transcript: '[{"text":"cloud"}]',
  };
  db.upsertNoteFromCloud(cloudNote, null);
  const after = db.getNote(before.id);

  assert.equal(after.title, "Cloud Title");
  assert.equal(after.content, "CLOUD EDIT");
  assert.equal(after.enhanced_content, "CLOUD ENHANCED");
  const transcriptRows = require("../../src/helpers/transcriptDocument").readTranscriptDocument(after.transcript).rows;
  assert.equal(transcriptRows[0].text, "cloud");
  assert.equal(transcriptRows[1].text,
    require("../../src/helpers/transcriptDocument").readTranscriptDocument(before.transcript).rows[0].text);
  assert.equal(
    after.enhancement_prompt,
    null,
    "a non-empty cloud enhancement brings its own prompt/hash (null here)"
  );
  assert.equal(after.sync_status, "pending", "the local-only row stays queued for upload");
});

test("upsertNoteFromCloud: a brand-new empty cloud note still inserts as-is", (t) => {
  const db = createDb(t);
  if (!db) return;

  const cloudNote = {
    id: "cloud-new-1",
    client_note_id: "client-new-1",
    title: "Fresh from cloud",
    content: "",
    enhanced_content: null,
    transcript: null,
    note_type: "personal",
    folder_id: null,
    source_file: null,
    audio_duration_seconds: null,
    enhancement_prompt: null,
    enhanced_at_content_hash: null,
    participants: null,
    calendar_event_id: null,
    diarization_enabled: null,
    expected_speaker_count: null,
    deleted_at: null,
    created_at: "2026-07-22T00:00:00.000Z",
    updated_at: "2026-07-22T00:00:00.000Z",
  };
  const row = db.upsertNoteFromCloud(cloudNote, null);

  assert.equal(row.title, "Fresh from cloud");
  assert.equal(row.content, "");
  assert.equal(row.sync_status, "synced");
});

test("upsertNoteFromCloud: a cloud copy from an API without template ids keeps the local one", (t) => {
  const db = createDb(t);
  if (!db) return;

  const before = seedEditedMeetingNote(db);
  const cloudNote = { ...emptyCloudShell(before), enhanced_content: "CLOUD ENHANCED" };
  assert.equal("enhancement_template_id" in cloudNote, false, "premise: an older API omits it");
  db.upsertNoteFromCloud(cloudNote, null);
  assert.equal(
    db.getNote(before.id).enhancement_template_id,
    "notes.actions.builtin.detailedNotes"
  );

  db.upsertNoteFromCloud(
    { ...cloudNote, enhancement_template_id: "c0ffee00-0000-4000-8000-000000000001" },
    null
  );
  assert.equal(
    db.getNote(before.id).enhancement_template_id,
    "c0ffee00-0000-4000-8000-000000000001",
    "a cloud copy that carries a template id brings its own"
  );
});

test("upsertNoteFromCloud: a cloud blank calendar_event_id clears the local link", (t) => {
  const db = createDb(t);
  if (!db) return;
  const before = seedEditedMeetingNote(db);
  db.updateNote(before.id, { calendar_event_id: "cal-ev-1" });

  db.upsertNoteFromCloud({ ...emptyCloudShell(before), calendar_event_id: "" }, null);

  assert.equal(db.getNote(before.id).calendar_event_id, "");
});

test("upsertNoteFromCloud: a cloud null calendar_event_id keeps the local link", (t) => {
  const db = createDb(t);
  if (!db) return;
  const before = seedEditedMeetingNote(db);
  db.updateNote(before.id, { calendar_event_id: "cal-ev-1" });

  db.upsertNoteFromCloud({ ...emptyCloudShell(before), calendar_event_id: null }, null);

  assert.equal(db.getNote(before.id).calendar_event_id, "cal-ev-1");
});

test("linking or unlinking an event retires an outstanding assistant Undo", (t) => {
  const db = createDb(t);
  if (!db) return;
  for (const [initial, next] of [
    [null, "evt-1"],
    ["evt-1", ""],
  ]) {
    const note = db.saveNote("Meeting", "", "meeting").note;
    if (initial) db.updateNote(note.id, { calendar_event_id: initial });
    db.updateNote(
      note.id,
      { title: "Assistant title" },
      { undoable: true, expected: db.getNote(note.id) }
    );
    assert.equal(db.getNoteUndos().length, 1);

    db.updateNote(note.id, { calendar_event_id: next });

    assert.equal(db.getNoteUndos().length, 0);
  }
});

test("clearing a linked note's event with null stores the synced blank", (t) => {
  const db = createDb(t);
  if (!db) return;
  const linked = db.saveNote("Meeting", "", "meeting").note;
  db.updateNote(linked.id, { calendar_event_id: "evt-1" });
  const unlinked = db.saveNote("Notes", "", "personal").note;

  // The local API and other non-UI callers may unlink with null.
  db.updateNote(linked.id, { calendar_event_id: null });
  db.updateNote(unlinked.id, { calendar_event_id: null });

  assert.equal(db.getNote(linked.id).calendar_event_id, "");
  assert.equal(db.getNote(unlinked.id).calendar_event_id, null, "a never-linked note stays NULL");

  // A null arriving while that unlink still waits to sync keeps it.
  db.updateNote(linked.id, { calendar_event_id: null });
  assert.equal(db.getNote(linked.id).calendar_event_id, "");
});

test('upsertNoteFromCloud keeps local correction history when cloud echoes the same labelled row', (t) => {
  const db = createDb(t);
  if (!db) return;
  const before = seedEditedMeetingNote(db);
  const readTranscriptDocument = (raw) => {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? { rows: parsed, unknownNumberHighWater: 0 } : parsed;
  };
  const corrected = { id: 'durable-row', text: 'Hello', source: 'system', speaker: 'speaker_0',
    speakerName: 'Alex', speakerLocked: true, speakerLockSource: 'user', unknownNumber: 4,
    corrections: [{ id: 'early', rowId: 'durable-row', previous: { speakerName: 'Prior' },
      next: { speakerName: 'Alex' }, actor: 'user', timestamp: '2026-01-01' }] };
  db.updateNote(before.id, { transcript: JSON.stringify({ version: 2,
    unknownNumberHighWater: 4, rows: [corrected] }) });
  const local = db.getNote(before.id);
  const cloud = { ...emptyCloudShell(local), transcript: JSON.stringify({ version: 2,
    unknownNumberHighWater: 4, rows: [{ id: corrected.id, text: corrected.text,
      source: corrected.source, speaker: corrected.speaker, speakerName: corrected.speakerName,
      speakerLocked: true, speakerLockSource: 'user', unknownNumber: 4 }] }) };
  assert.equal(cloud.transcript.includes('early'), false);
  db.upsertNoteFromCloud(cloud, null);
  const after = readTranscriptDocument(db.getNote(before.id).transcript);
  assert.equal(after.unknownNumberHighWater, 4);
  assert.equal(after.rows[0].speakerName, 'Alex');
  assert.equal(after.rows[0].corrections[0].id, 'early');
});

test('a conflicting cloud label on a locked row stays local and is surfaced', (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote('Meeting', '', 'meeting').note;
  const localRow = { id: 'durable-row', text: 'yes', source: 'system', speaker: 'speaker_0',
    speakerName: 'Alex', speakerLocked: true, speakerLockSource: 'user',
    corrections: [{ id: 'local-event', rowId: 'durable-row' }] };
  db.updateNote(note.id, { transcript: JSON.stringify([localRow]) });
  db.markNoteSynced(note.id, 'cloud-test-1');
  const local = db.getNote(note.id);
  const cloud = { ...emptyCloudShell(local), transcript: JSON.stringify([{ ...localRow,
    speakerName: 'Sam', corrections: [{ id: 'remote-event', rowId: 'durable-row' }] }]) };
  const result = db.upsertNoteFromCloud(cloud, null);
  assert.equal(result.transcript_conflict, true);
  assert.equal(db.getNote(note.id).transcript, local.transcript);
});

test('two untimed yes rows with different durable IDs stay separate on cloud pull', (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote('Meeting', '', 'meeting').note;
  db.updateNote(note.id, { transcript: JSON.stringify([{ id: 'local-yes', text: 'yes', source: 'system' }]) });
  const local = db.getNote(note.id);
  const cloud = { ...emptyCloudShell(local), transcript: JSON.stringify([{ id: 'remote-yes', text: 'yes', source: 'system' }]) };
  db.upsertNoteFromCloud(cloud, null);
  const rows = require('../../src/helpers/transcriptDocument').readTranscriptDocument(db.getNote(note.id).transcript).rows;
  assert.deepEqual(rows.map((row) => row.id), ['remote-yes', 'local-yes']);
  assert.equal(db.getNote(note.id).sync_status, 'pending');
});

test('an empty incoming synced transcript deletes its rows instead of restoring them', (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote('Meeting', '', 'meeting').note;
  db.updateNote(note.id, { transcript: JSON.stringify([{ id: 'synced-row', text: 'yes', source: 'system' }]) });
  db.markNoteSynced(note.id, 'cloud-test-1');
  const local = db.getNote(note.id);
  db.upsertNoteFromCloud({ ...emptyCloudShell(local), transcript: JSON.stringify({ version: 2, rows: [] }) }, null);
  const rows = require('../../src/helpers/transcriptDocument').readTranscriptDocument(db.getNote(note.id).transcript).rows;
  assert.equal(rows.filter((row) => !row.deleted).length, 0);
});

test('cloud history stays on its own device and Take theirs resolves a locked-label conflict', (t) => {
  const db = createDb(t);
  if (!db) return;
  const { readTranscriptDocument } = require('../../src/helpers/transcriptDocument');
  const note = db.saveNote('Meeting', '', 'meeting').note;
  const localRow = { id: 'shared-row', text: 'yes', source: 'system', speakerName: 'Alex',
    speakerLocked: true, speakerLockSource: 'user', corrections: [{ id: 'mine', rowId: 'shared-row' }] };
  db.updateNote(note.id, { transcript: JSON.stringify([localRow]) });
  db.markNoteSynced(note.id, 'cloud-test-1');
  const local = db.getNote(note.id);
  const cloud = { ...emptyCloudShell(local), transcript: JSON.stringify([
    { ...localRow, speakerName: 'Sam', corrections: [{ id: 'theirs', rowId: 'shared-row' }] },
    { id: 'remote-only', text: 'new', source: 'system', corrections: [{ id: 'remote-history', rowId: 'remote-only' }] },
  ]) };
  assert.equal(db.upsertNoteFromCloud(cloud, null).transcript_conflict, true);
  assert.equal(db.upsertNoteFromCloud(cloud, null, null, { takeTheirs: true }).transcript_conflict, undefined);
  const rows = readTranscriptDocument(db.getNote(note.id).transcript).rows;
  assert.equal(rows[0].speakerName, 'Sam');
  assert.equal(rows[0].corrections, undefined);
  assert.equal(rows[1].corrections, undefined);
});

test('Keep mine resolves the conflict as one pending local revision', (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote('Meeting', '', 'meeting').note;
  const localRow = { id: 'shared-row', text: 'yes', source: 'system', speakerName: 'Alex',
    speakerLocked: true, speakerLockSource: 'user' };
  db.updateNote(note.id, { transcript: JSON.stringify([localRow]) });
  db.markNoteSynced(note.id, 'cloud-test-1');
  const current = db.getNote(note.id);
  const cloud = { ...emptyCloudShell(current), revision: 7,
    transcript: JSON.stringify([{ ...localRow, speakerName: 'Sam' },
      { id: 'cloud-append', text: 'later', source: 'system' }]) };
  assert.equal(db.upsertNoteFromCloud(cloud, null).transcript_conflict, true);
  const result = db.setNoteCloudBase(note.id, cloud.updated_at, cloud.revision,
    { keepLocal: true, cloudNote: cloud });
  assert.equal(result.success, true);
  assert.equal(result.note.sync_status, 'pending');
  assert.equal(result.note.cloud_revision, 7);
  const rows = require('../../src/helpers/transcriptDocument').readTranscriptDocument(result.note.transcript).rows;
  assert.equal(rows[0].speakerName, 'Alex');
  assert.deepEqual(rows.map((row) => row.id), ['shared-row', 'cloud-append']);
});

test('legacy mapping transfer cannot replace a manual name or locked Unknown', (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote('Meeting', '', 'meeting').note;
  db.setSpeakerMapping(note.id, 'old', null, 'Alice');
  db.updateNote(note.id, { transcript: JSON.stringify([
    { id: 'manual', text: 'Hi', speaker: 'speaker_0', speakerName: 'Sam',
      speakerLocked: true, speakerLockSource: 'user' },
  ]) });
  assert.equal(db.transferLegacySpeakerMapping(note.id, 'old', 'speaker_0', null, 'Alice'), false);
  assert.equal(db.getSpeakerMappings(note.id).find((m) => m.speaker_id === 'speaker_0'), undefined);
  db.updateNote(note.id, { transcript: JSON.stringify([
    { id: 'named', text: 'Hi', speaker: 'speaker_0', speakerName: 'Sam' },
  ]) });
  assert.equal(db.transferLegacySpeakerMapping(note.id, 'old', 'speaker_0', null, 'Alice'), false);
  assert.equal(db.getSpeakerMappings(note.id).find((m) => m.speaker_id === 'speaker_0'), undefined);
  db.updateNote(note.id, { transcript: JSON.stringify([
    { id: 'unknown', text: 'Hi', speaker: 'speaker_0', speakerLocked: true,
      speakerLockSource: 'user', speakerIsPlaceholder: true },
  ]) });
  assert.equal(db.transferLegacySpeakerMapping(note.id, 'old', 'speaker_0', null, 'Alice'), false);
  assert.equal(db.getSpeakerMappings(note.id).find((m) => m.speaker_id === 'speaker_0'), undefined);
  db.updateNote(note.id, { transcript: JSON.stringify([
    { id: 'unowned', text: 'Hi', speaker: 'speaker_0' },
  ]) });
  assert.equal(db.transferLegacySpeakerMapping(note.id, 'old', 'speaker_0', null, 'Alice'), true);
  assert.equal(db.getSpeakerMappings(note.id).find((m) => m.speaker_id === 'speaker_0').display_name, 'Alice');
});

test('a local deletion marker survives a cloud pull of the old live row', (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote('Meeting', '', 'meeting').note;
  const original = { id: 'deleted-row', text: 'yes', source: 'system' };
  db.updateNote(note.id, { transcript: JSON.stringify([original]) });
  db.markNoteSynced(note.id, 'cloud-test-1');
  db.updateNote(note.id, { transcript: JSON.stringify({ version: 2, rows: [] }) });
  const local = db.getNote(note.id);
  const rows = require('../../src/helpers/transcriptDocument').readTranscriptDocument(local.transcript).rows;
  assert.equal(rows[0].deleted, true);
  const cloud = { ...emptyCloudShell(local), transcript: JSON.stringify([original]) };
  assert.equal(db.upsertNoteFromCloud(cloud, null).transcript_conflict, true);
  assert.equal(db.getNote(note.id).transcript, local.transcript);
});

test('a deletion after another pending edit still keeps a durable row marker', (t) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote('Meeting', '', 'meeting').note;
  db.updateNote(note.id, { transcript: JSON.stringify([{ id: 'one', text: 'yes', source: 'system' }]) });
  db.markNoteSynced(note.id, 'cloud-test-1');
  db.updateNote(note.id, { title: 'Edited title' });
  db.updateNote(note.id, { transcript: JSON.stringify({ version: 2, rows: [] }) });
  const rows = require('../../src/helpers/transcriptDocument').readTranscriptDocument(db.getNote(note.id).transcript).rows;
  assert.equal(rows[0].id, 'one');
  assert.equal(rows[0].deleted, true);
});

test('a newly pulled note never imports another device correction history', (t) => {
  const db = createDb(t);
  if (!db) return;
  const cloud = { ...emptyCloudShell({ updated_at: '2026-01-01T00:00:00Z', client_note_id: 'new-cloud-note' }),
    client_note_id: 'new-cloud-note', transcript: JSON.stringify([{ id: 'remote-row', text: 'yes',
      source: 'system', corrections: [{ id: 'remote-event', rowId: 'remote-row' }],
      suggestedName: 'Old name' }]) };
  const result = db.upsertNoteFromCloud(cloud, null);
  const [row] = require('../../src/helpers/transcriptDocument').readTranscriptDocument(result.transcript).rows;
  assert.equal(row.corrections, undefined);
  assert.equal(row.suggestedName, undefined);
});
