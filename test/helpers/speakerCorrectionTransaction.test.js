const test = require("node:test");
const assert = require("node:assert/strict");
const { applySpeakerCorrection } = require("../../src/helpers/speakerCorrectionTransaction");

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
          const snapshot = { transcript: note.transcript, mappings: new Map(mappings) };
          try {
            const result = fn(...args);
            if (fail) throw Error("injected persistence failure");
            return result;
          } catch (error) {
            note.transcript = snapshot.transcript;
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
      note.transcript = update.transcript;
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
const rows = (f) => JSON.parse(f.note.transcript);

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
test("older correction on different target can be undone", () => {
  const f = fixture();
  applySpeakerCorrection(f.db, f.identifier, correction("c1", "a", "Alex"));
  applySpeakerCorrection(f.db, f.identifier, correction("c2", "b", "Sam", "speaker_1"));
  const result = applySpeakerCorrection(f.db, f.identifier, { type: "undo", noteId: 1, id: "c1" });
  assert.equal(result.success, true);
  assert.equal(rows(f)[0].speakerName, undefined);
  assert.equal(rows(f)[1].speakerName, "Sam");
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
  applySpeakerCorrection(f.db, f.identifier, correction("c2", "other", "Sam", "speaker_0", "run2"));
  applySpeakerCorrection(f.db, f.identifier, { type: "undo", noteId: 1, id: "c1" });
  assert.equal(rows(f).find((r) => r.id === "other").speakerName, "Sam");
  assert.equal(f.mappings.size, 1);
  assert.equal(f.identifier.transientDisplayNames.get("speaker_0"), "Sam");
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
