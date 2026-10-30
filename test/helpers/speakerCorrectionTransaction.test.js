const test = require("node:test");
const assert = require("node:assert/strict");
const { applySpeakerCorrection, MAX_CORRECTION_BYTES } = require("../../src/helpers/speakerCorrectionTransaction");

const row = (id, cluster = "speaker_0", run = "run1") => ({
  id,
  text: id,
  source: "system",
  speaker: cluster,
  diarizationRunId: run,
});
const fixture = () => {
  const note = { transcript: JSON.stringify([row("a"), row("b", "speaker_1")]) };
  const mappings = new Map();
  const identifier = {
    activeRunId: "run1",
    transientDisplayNames: new Map(),
    transientProfileIds: new Map(),
    mapSpeaker(id, profile, name) {
      this.transientDisplayNames.set(id, name);
      if (profile != null) this.transientProfileIds.set(id, profile);
    },
    unmapSpeaker(id) {
      this.transientDisplayNames.delete(id);
      this.transientProfileIds.delete(id);
    },
  };
  let fail = false;
  const db = {
    getNote: () => note,
    db: {
      transaction(fn) {
        return (...args) => {
          const snapshot = { transcript: note.transcript, speaker_action_log: note.speaker_action_log,
            mappings: new Map(mappings) };
          try {
            const result = fn(...args);
            if (fail) throw Error("injected persistence failure");
            return result;
          } catch (error) {
            note.transcript = snapshot.transcript;
            note.speaker_action_log = snapshot.speaker_action_log;
            mappings.clear();
            for (const [k, v] of snapshot.mappings) mappings.set(k, v);
            throw error;
          }
        };
      },
    },
    getSpeakerRunMapping(_noteId, run, cluster) {
      return mappings.get(`${run}:${cluster}`) || null;
    },
    setSpeakerRunMapping(_noteId, run, cluster, profile_id, display_name) {
      mappings.set(`${run}:${cluster}`, { profile_id, display_name });
      return { success: true };
    },
    removeSpeakerRunMapping(_noteId, run, cluster) {
      mappings.delete(`${run}:${cluster}`);
      return { success: true };
    },
    updateNote(_id, update) {
      Object.assign(note, update);
      return { success: true, note };
    },
  };
  return {
    db,
    note,
    mappings,
    identifier,
    failNext: () => {
      fail = true;
    },
  };
};
const correction = (
  id,
  targetRow,
  name,
  cluster = "speaker_0",
  run = "run1",
  profileId = null
) => ({
  type: "apply",
  noteId: 1,
  id,
  scope: "cluster",
  rowIds: [targetRow],
  target: { runId: run, clusterId: cluster },
  name,
  profileId,
  rows: [row(targetRow, cluster, run)],
});
const rows = (f) => require("../../src/helpers/transcriptDocument").readTranscriptDocument(f.note.transcript).rows;

test("atomic correction merges a live row appended while IPC waits", () => {
  const f = fixture();
  const request = correction("c1", "a", "Alex");
  f.note.transcript = JSON.stringify([...rows(f), row("late")]);
  applySpeakerCorrection(f.db, f.identifier, request);
  assert.deepEqual(
    rows(f).map((x) => x.id),
    ["a", "b", "late"]
  );
  assert.equal(rows(f)[0].speakerName, "Alex");
});
test("failed persistence leaves mapping transcript and identifier unchanged", () => {
  const f = fixture();
  const before = f.note.transcript;
  f.failNext();
  assert.throws(
    () => applySpeakerCorrection(f.db, f.identifier, correction("c1", "a", "Alex")),
    /injected/
  );
  assert.equal(f.note.transcript, before);
  assert.equal(f.mappings.size, 0);
  assert.equal(f.identifier.transientDisplayNames.size, 0);
});
test("map undo and another identification cannot revive name or profile", () => {
  const f = fixture();
  applySpeakerCorrection(f.db, f.identifier, correction("c1", "a", "Alex", "speaker_0", "run1", 7));
  applySpeakerCorrection(f.db, f.identifier, { type: "undo", noteId: 1, id: "c1" });
  assert.equal(f.mappings.size, 0);
  assert.equal(f.identifier.transientDisplayNames.size, 0);
  assert.equal(f.identifier.transientProfileIds.size, 0);
  assert.equal(rows(f)[0].speakerName, undefined);
});
test("older correction on different target waits for newest action", () => {
  const f = fixture();
  applySpeakerCorrection(f.db, f.identifier, correction("c1", "a", "Alex"));
  applySpeakerCorrection(f.db, f.identifier, correction("c2", "b", "Sam", "speaker_1"));
  const result = applySpeakerCorrection(f.db, f.identifier, { type: "undo", noteId: 1, id: "c1" });
  assert.equal(result.error, 'later_change');
  assert.equal(applySpeakerCorrection(f.db, f.identifier, { type: 'undo', noteId: 1, id: 'c2' }).success, true);
  assert.equal(applySpeakerCorrection(f.db, f.identifier, { type: 'undo', noteId: 1, id: 'c1' }).success, true);
  assert.equal(rows(f)[0].speakerName, undefined);
  assert.equal(rows(f)[1].speakerName, undefined);
});
test("older correction on same cluster target is refused", () => {
  const f = fixture();
  applySpeakerCorrection(f.db, f.identifier, correction("c1", "a", "Alex"));
  applySpeakerCorrection(f.db, f.identifier, correction("c2", "a", "Sam"));
  const result = applySpeakerCorrection(f.db, f.identifier, { type: "undo", noteId: 1, id: "c1" });
  assert.equal(result.error, "later_change");
  assert.equal(rows(f)[0].speakerName, "Sam");
});
test("cluster undo restores only its run mapping", () => {
  const f = fixture();
  applySpeakerCorrection(f.db, f.identifier, correction("c1", "a", "Alex"));
  f.note.transcript = JSON.stringify([...rows(f), row("other", "speaker_0", "run2")]);
  f.identifier.activeRunId = "run2";
  applySpeakerCorrection(f.db, f.identifier, correction("c2", "other", "Sam", "speaker_0", "run2"));
  assert.equal(applySpeakerCorrection(f.db, f.identifier, { type: "undo", noteId: 1, id: "c1" }).error, 'later_change');
  applySpeakerCorrection(f.db, f.identifier, { type: "undo", noteId: 1, id: "c2" });
  applySpeakerCorrection(f.db, f.identifier, { type: "undo", noteId: 1, id: "c1" });
  assert.equal(rows(f).find((r) => r.id === "other").speakerName, undefined);
  assert.equal(f.mappings.size, 0);
});

test("same-target undo uses event order when the clock moves backward", () => {
  const f = fixture();
  applySpeakerCorrection(f.db, f.identifier, correction("c1", "a", "Alex"));
  applySpeakerCorrection(f.db, f.identifier, correction("c2", "a", "Sam"));
  const current = rows(f);
  current[0].corrections[1].timestamp = "2000-01-01T00:00:00.000Z";
  f.note.transcript = JSON.stringify(current);
  const result = applySpeakerCorrection(f.db, f.identifier, { type: "undo", noteId: 1, id: "c1" });
  assert.equal(result.error, "later_change");
});

test('an early correction survives 55 later corrections to other rows', () => {
  const f = fixture();
  f.note.transcript = JSON.stringify(Array.from({ length: 56 }, (_, i) => row(`r${i}`, `speaker_${i}`, 'run1')));
  for (let i = 0; i < 56; i++) {
    const result = applySpeakerCorrection(f.db, f.identifier, {
      type: 'apply', noteId: 1, id: `correction-${i}`, scope: 'row',
      rowIds: [`r${i}`], name: `Person ${i}`, rows: [],
    });
    assert.equal(result.success, true);
  }
  assert.equal(rows(f)[0].corrections[0].id, 'correction-0');
  assert.equal(applySpeakerCorrection(f.db, f.identifier,
    { type: 'undo', noteId: 1, id: 'correction-0' }).error, 'later_change');
  for (let i = 55; i > 0; i--) assert.equal(applySpeakerCorrection(f.db, f.identifier,
    { type: 'undo', noteId: 1, id: `correction-${i}` }).success, true);
  assert.equal(applySpeakerCorrection(f.db, f.identifier,
    { type: 'undo', noteId: 1, id: 'correction-0' }).success, true);
  assert.equal(rows(f)[0].speakerName, undefined);
  assert.equal(rows(f)[55].speakerName, undefined);
});

test('a cloud label change preserves the local event and label without conflict', () => {
  const f = fixture();
  applySpeakerCorrection(f.db, f.identifier, {
    type: 'apply', noteId: 1, id: 'c1', scope: 'row', rowIds: ['a'], name: 'Alex', rows: [],
  });
  const { reconcileCloudTranscript, writeTranscriptDocument } = require('../../src/helpers/transcriptDocument');
  const cloudRows = rows(f).map((entry) => ({ id: entry.id, text: entry.text,
    source: entry.source, speaker: entry.speaker, speakerName: entry.id === 'a' ? 'Sam' : undefined,
    speakerLocked: entry.id === 'a', speakerLockSource: entry.id === 'a' ? 'user' : undefined }));
  const result = reconcileCloudTranscript(writeTranscriptDocument(cloudRows), f.note.transcript);
  assert.equal(result.conflicted, undefined);
  f.note.transcript = result.transcript;
  assert.equal(rows(f)[0].corrections[0].id, 'c1');
  assert.equal(rows(f)[0].speakerName, 'Alex');
  assert.equal(applySpeakerCorrection(f.db, f.identifier,
    { type: 'undo', noteId: 1, id: 'c1' }).success, true);
  assert.equal(rows(f)[0].speakerName, undefined);
});

test('owner can correct a 650-row cluster and undo it from one indexed event', () => {
  const f = fixture();
  f.note.transcript = JSON.stringify(Array.from({ length: 650 }, (_, i) => row(`r${i}`)));
  const result = applySpeakerCorrection(f.db, f.identifier, correction('large-cluster', 'r0', 'Alex'));
  assert.equal(result.success, true, result.error);
  assert.equal(rows(f).length, 650);
  assert.equal(rows(f).filter((r) => r.speakerName === 'Alex').length, 650);
  const history = rows(f).flatMap((r) => r.corrections || []);
  assert.equal(history.filter((record) => record.snapshots).length, 1);
  assert.equal(Object.keys(history.find((record) => record.snapshots).snapshots).length, 650);
  assert.equal(applySpeakerCorrection(f.db, f.identifier,
    { type: 'undo', noteId: 1, id: 'large-cluster' }).success, true);
  assert.equal(rows(f).filter((r) => r.speakerName).length, 0);
});

test('owner can correct a 500-row selection without filling first-event history', () => {
  const f = fixture();
  f.note.transcript = JSON.stringify(Array.from({ length: 500 }, (_, i) => row(`r${i}`)));
  const result = applySpeakerCorrection(f.db, f.identifier, {
    type: 'apply', noteId: 1, id: 'large-selection', scope: 'selected',
    rowIds: Array.from({ length: 500 }, (_, i) => `r${i}`), name: 'Alex', rows: [],
  });
  assert.equal(result.success, true, result.error);
  assert.equal(rows(f).filter((r) => r.speakerName === 'Alex').length, 500);
});

test('an oversized action rejects without changing the transcript or action log', () => {
  const f = fixture();
  const before = f.note.transcript;
  const result = applySpeakerCorrection(f.db, f.identifier, {
    type: 'apply', noteId: 1, id: 'huge', scope: 'row', rowIds: ['a'],
    name: 'A'.repeat(MAX_CORRECTION_BYTES + 1), rows: [],
  });
  assert.equal(result.error, 'history_full');
  assert.equal(f.note.transcript, before);
  assert.equal(f.note.speaker_action_log, undefined);
});

test('undoing an old run never replaces the active run cache with its historical name', () => {
  const f = fixture();
  applySpeakerCorrection(f.db, f.identifier, correction('old', 'a', 'Alex'));
  f.identifier.activeRunId = 'run2';
  f.identifier.mapSpeaker('speaker_0', 8, 'Sam');
  f.mappings.set('run2:speaker_0', { display_name: 'Sam', profile_id: 8 });
  assert.equal(applySpeakerCorrection(f.db, f.identifier,
    { type: 'undo', noteId: 1, id: 'old' }).success, true);
  assert.equal(f.identifier.transientDisplayNames.get('speaker_0'), 'Sam');
  assert.equal(f.mappings.get('run1:speaker_0'), undefined);
  assert.equal(f.mappings.get('run2:speaker_0').display_name, 'Sam');
});
