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
test("a failed completion is visible with its count and exact cause in calibration", () => {
  const { collectRows } = require("../../src/helpers/speakerInAppCalibration");
  const note = {
    id: 62,
    transcript: JSON.stringify([
      {
        id: "reviewed",
        speaker: "speaker_7",
        speakerName: "Ada",
        speakerLockSource: "user",
        source: "system",
        audioSpan: { trackId: "system", recordingId: 1, startSample: 0, endSample: 48000 },
      },
    ]),
    speaker_action_log: null,
    created_at: "2026-11-02",
  };
  const collected = collectRows(
    {
      db: { prepare: () => ({ all: () => [note] }) },
      getNoteSpeakerEmbeddings: () => [],
      getNoteSpeakerCompletion: () => ({
        hadSpeakerEmbeddings: false,
        clusters: 1,
        vectorsWritten: 0,
        cause: "embedding_extraction_failed",
      }),
    },
    { status: () => ({ state: "expired", tracks: {} }) },
    { kind: "all" },
    { notes: 1, rows: 10 }
  );
  assert.deepEqual(collected.noteCentroidCompletions, [
    { noteId: 62, clusters: 1, vectorsWritten: 0, cause: "embedding_extraction_failed" },
  ]);
  assert.equal(collected.missingVectorDiagnostics[0].reason, "embedding_extraction_failed");
  assert.match(collected.missingVectorDiagnostics[0].message, /0 of 1 cluster vectors written/);
});
test("a verified completion supplies stored centroid evidence to calibration", () => {
  const { collectRows } = require("../../src/helpers/speakerInAppCalibration");
  const note = {
    id: 63,
    transcript: JSON.stringify([
      {
        id: "reviewed",
        speaker: "speaker_7",
        speakerName: "Ada",
        speakerLockSource: "user",
        source: "system",
        audioSpan: { trackId: "system", recordingId: 1, startSample: 0, endSample: 48000 },
      },
    ]),
    speaker_action_log: null,
    created_at: "2026-11-02",
  };
  const collected = collectRows(
    {
      db: { prepare: () => ({ all: () => [note] }) },
      getNoteSpeakerEmbeddings: () => [
        { speaker_id: "speaker_7", embedding: Buffer.from(new Float32Array([1, 0]).buffer) },
      ],
      getNoteSpeakerCompletion: () => ({
        hadSpeakerEmbeddings: true,
        clusters: 1,
        vectorsWritten: 1,
        cause: null,
      }),
    },
    { status: () => ({ state: "complete", tracks: {} }) },
    { kind: "all" },
    { notes: 1, rows: 10 }
  );
  assert.equal(collected.rows[0].vectorSource, "stored-centroid-current-profiles");
  assert.deepEqual(collected.noteCentroidCompletions, [
    { noteId: 63, clusters: 1, vectorsWritten: 1 },
  ]);
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

test("reconstructed reviewed audio is labelled and can calibrate only with the full evidence gate", () => {
  const report = buildReport({
    rows: rows.map((row) => ({
      ...row,
      vectorSource: "reconstructed-row-audio",
      liveVector: row.vector,
    })),
    profiles,
    scope: { kind: "all" },
    modelFingerprint: "b".repeat(64),
    reviewedCount: 40,
  });
  assert.equal(report.evidence.reconstructedRows, 40);
  assert.equal(report.evidence.storedRows, 0);
  assert.equal(report.analyses.exact.rows, 0);
  assert.equal(report.support.similarityFloor.method, "reconstructed-row-audio");
  assert.equal(report.support.similarityFloor.status, "calibrated");
  assert.match(report.evidence.coverage, /40 of 40 reviewed rows reconstructed/);
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
    const snapshot = JSON.parse(
      db.prepare("SELECT snapshot FROM speaker_calibration_actions WHERE id = ?").get(applied.id)
        .snapshot
    );
    assert.deepEqual(snapshot.previous.values, before.values);
    assert.deepEqual(snapshot.next.statuses, applied.statuses);
    assert.equal(snapshot.reportId, report.id);
    assert.deepEqual(snapshot.revisions, report.evidence.revisions);
    assert.deepEqual(snapshot.fingerprints, report.fingerprints);
    assert.deepEqual(snapshot.exclusions, report.evidence.exclusions);
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
  const { runJob, reportStillCurrent } = require("../../src/helpers/speakerInAppCalibration");
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
  let noteEmbeddings = [{ speaker_id: 1, embedding: Buffer.from(new Float32Array([1, 0]).buffer) }];
  const wav = Buffer.alloc(44 + 48000 * 2);
  wav.write("data", 36);
  wav.writeUInt32LE(48000 * 2, 40);
  wav.writeUInt32LE(24000, 24);
  const database = {
    db: { prepare: () => ({ all: () => [note] }) },
    getNote: () => note,
    getNoteSpeakerEmbeddings: () => noteEmbeddings,
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
    assert.equal(job.report.support.similarityFloor.method, "stored-centroid-current-profiles");
    assert.equal(await reportStillCurrent(job.report, database, audioStore, model), true);
    noteEmbeddings = [];
    assert.equal(await reportStillCurrent(job.report, database, audioStore, model), false);
    noteEmbeddings = [{ speaker_id: 1, embedding: Buffer.from(new Float32Array([1, 0]).buffer) }];
    note.transcript = JSON.stringify([{ ...row, text: "edited after calibration" }]);
    assert.equal(await reportStillCurrent(job.report, database, audioStore, model), false);
    note.transcript = JSON.stringify([row]);
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

test("missing centroids use retained row audio and never write speaker training data", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { runJob } = require("../../src/helpers/speakerInAppCalibration");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speaker-backfill-"));
  const modelPath = path.join(dir, "model.onnx");
  fs.writeFileSync(modelPath, "fixture model");
  const row = {
    id: "reviewed",
    source: "system",
    speaker: "split-1",
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
  let writes = 0;
  let completion = { hadSpeakerEmbeddings: false };
  let storedEmbeddings = [];
  const database = {
    db: { prepare: () => ({ all: () => [note] }) },
    getNoteSpeakerEmbeddings: () => storedEmbeddings,
    getNoteSpeakerCompletion: () => completion,
    getSpeakerProfiles: () => [
      { id: 1, display_name: "Ada", embedding: Buffer.from(new Float32Array([1, 0]).buffer) },
      { id: 2, display_name: "Ben", embedding: Buffer.from(new Float32Array([0, 1]).buffer) },
    ],
    saveNoteSpeakerEmbeddings: () => {
      writes++;
    },
    saveSpeakerProfile: () => {
      writes++;
    },
    saveVoiceExemplar: () => {
      writes++;
    },
  };
  let state = "complete";
  const audioStore = {
    status: () => ({
      state,
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
  const job = () => ({
    cancelled: false,
    state: "running",
    progress: { totalRows: 0, processedRows: 0, reembeddedRows: 0, bytesRead: 0, elapsedMs: 0 },
  });
  try {
    const retained = job();
    await runJob(retained, database, audioStore, { kind: "all" }, { notes: 1, rows: 1 }, model);
    assert.equal(retained.report.evidence.reconstructedRows, 1);
    assert.equal(retained.report.evidence.coverage, "1 of 1 reviewed rows reconstructed");
    assert.equal(
      retained.report.evidence.missingVectorDiagnostics[0].reason,
      "completion_without_speakerEmbeddings"
    );
    assert.equal(retained.report.analyses.calibration.rows, 1);
    assert.equal(retained.report.support.similarityFloor.status, "uncalibrated");
    assert.equal(writes, 0);
    completion = null;
    const noEvent = job();
    await runJob(noEvent, database, audioStore, { kind: "all" }, { notes: 1, rows: 1 }, model);
    assert.equal(noEvent.report.evidence.missingVectorDiagnostics[0].reason, "no_completion_event");
    completion = { hadSpeakerEmbeddings: true };
    storedEmbeddings = [
      { speaker_id: "speaker_1", embedding: Buffer.from(new Float32Array([1, 0]).buffer) },
    ];
    const mismatched = job();
    await runJob(mismatched, database, audioStore, { kind: "all" }, { notes: 1, rows: 1 }, model);
    assert.equal(
      mismatched.report.evidence.missingVectorDiagnostics[0].reason,
      "speaker_id_vs_speaker_key_mismatch"
    );
    state = "expired";
    const expired = job();
    await runJob(expired, database, audioStore, { kind: "all" }, { notes: 1, rows: 1 }, model);
    assert.equal(expired.report.evidence.reconstructedRows, 0);
    assert.ok(expired.report.evidence.exclusions.some((item) => item.reason === "audio_expired"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
