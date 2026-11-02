const test = require("node:test");
const assert = require("node:assert/strict");
const { buildReport } = require("../../src/helpers/speakerInAppCalibration");
const profiles = [
  { id: 1, name: "Ada", vector: [1, 0] },
  { id: 2, name: "Ben", vector: [0, 1] },
];
const rows = Array.from({ length: 40 }, (_, i) => ({
  noteId: 1 + Math.floor(i / 4),
  rowId: `row-${i}`,
  revision: `revision-${i}`,
  truePerson: i % 2 ? "Ben" : "Ada",
  machineLabel: i % 2 ? "Ben" : "Ada",
  clusterId: i % 2 ? "2" : "1",
  vector: i % 2 ? [0.1, 0.99] : [0.99, 0.1],
  audioFingerprint: "a".repeat(64),
}));
test("stored centroid sweep measures the final pass against current profiles and refuses unsupported gates", () => {
  const report = buildReport({
    rows,
    profiles,
    scope: { kind: "all" },
    modelFingerprint: "b".repeat(64),
  });
  assert.equal(report.method, "stored-centroid-current-profiles");
  assert.equal(report.analyses.exact.label, "Measured against your profiles as they are today");
  assert.equal(report.evidence.notes, 10);
  assert.equal(report.support.similarityFloor.status, "calibrated");
  assert.equal(report.support.runnerUpMargin.status, "calibrated");
  assert.equal(report.support.minimumVoicedSeconds.status, "uncalibrated");
  assert.equal(report.support.overlapToleranceSeconds.status, "uncalibrated");
  assert.equal(report.recommended.minimumVoicedSeconds, undefined);
  assert.equal(report.recommended.overlapToleranceSeconds, undefined);
});
test("live row comparison is explicitly estimated and never uses a centroid as a live query", () => {
  const report = buildReport({
    rows: rows.map((row) => ({ ...row, liveVector: row.vector })),
    profiles,
    scope: { kind: "all" },
    modelFingerprint: "b".repeat(64),
  });
  assert.equal(report.analyses.estimated.label.includes("Estimate"), true);
  assert.equal(report.analyses.estimated.rows, 40);
  assert.equal(report.analyses.estimated.reason.includes("32 kb/s Opus"), true);
});

test("applying a supported report records an ordered action and undo restores status and values", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { DatabaseSync } = require("node:sqlite");
  const thresholds = require("../../src/helpers/speakerDecisionThresholds");
  const action = require("../../src/helpers/speakerCalibrationAction");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speaker-calibration-action-"));
  const db = new DatabaseSync(":memory:");
  db.transaction =
    (fn) =>
    (...args) => {
      db.exec("BEGIN");
      try {
        const value = fn(...args);
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    };
  db.exec(
    "CREATE TABLE notes (id INTEGER PRIMARY KEY, deleted_at TEXT); INSERT INTO notes (id) VALUES (1)"
  );
  try {
    thresholds.configure(path.join(dir, "thresholds.json"));
    const before = thresholds.current();
    assert.equal(thresholds.effectiveFloor(), 0.6);
    const report = buildReport({
      rows,
      profiles,
      scope: { kind: "all" },
      modelFingerprint: "b".repeat(64),
    });
    const applied = action.apply({ db }, report);
    assert.equal(applied.success, true);
    assert.equal(applied.statuses.similarityFloor, "calibrated");
    assert.equal(thresholds.effectiveFloor(), report.recommended.similarityFloor);
    thresholds.configure(path.join(dir, "thresholds.json"));
    assert.equal(thresholds.current().statuses.similarityFloor, "calibrated");
    assert.equal(applied.statuses.minimumVoicedSeconds, "uncalibrated");
    assert.equal(
      db.prepare("SELECT kind FROM speaker_global_actions WHERE id = ?").get(applied.id).kind,
      "calibration"
    );
    const history = require("../../src/helpers/speakerGlobalHistory");
    history.add(db, { id: "later-owner-correction", kind: "correction", noteId: 1 });
    assert.equal(action.undo({ db }, applied.id).error, "later_change");
    history.remove(db, "later-owner-correction", 1);
    assert.equal(action.undo({ db }, applied.id).success, true);
    assert.deepEqual(thresholds.current(), before);
    assert.equal(thresholds.effectiveFloor(), 0.6);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM speaker_global_actions").get().n, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    thresholds.configure(null);
  }
});
test("a plausible hash and positive row count alone cannot calibrate a parameter", () => {
  const thresholds = require("../../src/helpers/speakerDecisionThresholds");
  thresholds.configure(null);
  thresholds.apply(
    { ...thresholds.DEFAULTS },
    {
      version: 1,
      synthetic: false,
      audioSha256: { mic: "a".repeat(64) },
      evidence: { rowCount: 400 },
    }
  );
  assert.equal(thresholds.current().statuses.similarityFloor, "uncalibrated");
});
