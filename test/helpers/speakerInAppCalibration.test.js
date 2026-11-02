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

test("background job counts retained bytes and re-embedded reviewed rows", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { runJob } = require("../../src/helpers/speakerInAppCalibration");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speaker-calibration-job-"));
  const modelPath = path.join(dir, "model.onnx");
  fs.writeFileSync(modelPath, "fixture model");
  const row = {
    id: "reviewed-row",
    text: "hello",
    source: "system",
    speaker: 1,
    speakerName: "Ada",
    speakerLockSource: "user",
    audioSpan: { trackId: "system", recordingId: 1, startSample: 0, endSample: 48000 },
  };
  const note = {
    id: 1,
    transcript: JSON.stringify([row]),
    speaker_action_log: null,
    created_at: "2026-10-01",
  };
  const wav = Buffer.alloc(44 + 48000 * 2);
  wav.write("data", 36);
  wav.writeUInt32LE(48000 * 2, 40);
  wav.writeUInt32LE(24000, 24);
  const database = {
    db: { prepare: () => ({ all: () => [note] }) },
    getNoteSpeakerEmbeddings: () => [
      { speaker_id: 1, embedding: Buffer.from(new Float32Array([1, 0]).buffer) },
    ],
    getSpeakerProfiles: () => [
      { id: 1, display_name: "Ada", embedding: Buffer.from(new Float32Array([1, 0]).buffer) },
      { id: 2, display_name: "Ben", embedding: Buffer.from(new Float32Array([0, 1]).buffer) },
    ],
  };
  const audioStore = {
    status: () => ({
      state: "complete",
      bytes: 100,
      recordingId: 1,
      tracks: { system: { chunks: [{ startSample: 0, sampleCount: 48000 }] } },
    }),
    span: () => ({ wav, bytesRead: 1234 }),
  };
  const model = {
    isAvailable: () => true,
    getModelPath: () => modelPath,
    extractEmbeddingFromSamples: async () => new Float32Array([1, 0]),
  };
  const job = {
    cancelled: false,
    state: "running",
    progress: { totalRows: 0, processedRows: 0, reembeddedRows: 0, bytesRead: 0, elapsedMs: 0 },
  };
  try {
    await runJob(job, database, audioStore, { kind: "all" }, { notes: 1, rows: 1 }, model);
    assert.equal(job.state, "complete");
    assert.equal(job.progress.processedRows, 1);
    assert.equal(job.progress.reembeddedRows, 1);
    assert.equal(job.progress.bytesRead, 1234);
    assert.equal(job.report.analyses.estimated.rows, 1);
    const cancelled = {
      cancelled: false,
      state: "running",
      progress: { totalRows: 0, processedRows: 0, reembeddedRows: 0, bytesRead: 0, elapsedMs: 0 },
    };
    await runJob(
      cancelled,
      database,
      audioStore,
      { kind: "all" },
      { notes: 1, rows: 1 },
      {
        ...model,
        extractEmbeddingFromSamples: async () => {
          cancelled.cancelled = true;
          return new Float32Array([1, 0]);
        },
      }
    );
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.report, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
