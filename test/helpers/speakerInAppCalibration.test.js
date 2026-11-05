const test = require("node:test");
const assert = require("node:assert/strict");
const { buildReport } = require("../../src/helpers/speakerInAppCalibration");
const { recommendationFixture } = require("../lib/speakerRecommendationFixture");
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
test("all-refusal evidence is diagnostic_only with no recommendation", () => {
  const report = buildReport({
    rows: rows.map((row) => ({ ...row, vector: [-1, -1] })),
    profiles,
    scope: { kind: "all" },
    modelFingerprint: "b".repeat(64),
  });
  assert.equal(report.resultType, "diagnostic_only");
  assert.deepEqual(report.recommended, {});
  assert.ok(report.failedCriteria.includes("nonempty_accepted_set"));
});
test("tied profiles never report calibrated", () => {
  const report = buildReport({
    rows,
    profiles: profiles.map((profile) => ({ ...profile, vector: [1, 0] })),
    scope: { kind: "all" },
    modelFingerprint: "b".repeat(64),
  });
  assert.equal(report.resultType, "diagnostic_only");
  assert.deepEqual(report.recommended, {});
  assert.equal(report.support.similarityFloor.status, "uncalibrated");
});
test("stored centroid sweep measures the final pass against current profiles and refuses unsupported gates", () => {
  const report = buildReport({
    rows,
    profiles,
    scope: { kind: "all" },
    modelFingerprint: "b".repeat(64),
  });
  assert.equal(report.method, "stored-centroid-current-profiles");
  assert.deepEqual(Object.keys(report.analyses), ["calibration"]);
  assert.equal(report.evidence.notes, 10);
  assert.equal(report.resultType, "diagnostic_only");
  assert.equal(report.support.similarityFloor.status, "uncalibrated");
  assert.equal(report.support.runnerUpMargin.status, "uncalibrated");
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
test("exactly one reconstructed diagnostic sweep is produced", () => {
  const report = buildReport({
    rows: rows.map((row) => ({
      ...row,
      vectorSource: "reconstructed-row-audio",
      liveVector: row.vector,
    })),
    profiles,
    scope: { kind: "all" },
    modelFingerprint: "b".repeat(64),
  });
  assert.deepEqual(Object.keys(report.analyses), ["calibration"]);
  assert.equal(report.analyses.calibration.rows, 40);
  assert.equal(report.analyses.calibration.table.length, 20);
});

test("reconstructed reviewed audio remains diagnostic without production parity and independent validation", () => {
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
  assert.equal(report.evidence.exactClusters, 0);
  assert.equal(report.support.similarityFloor.method, "reconstructed-row-audio");
  assert.equal(report.support.similarityFloor.status, "uncalibrated");
  assert.ok(report.failedCriteria.includes("production_parity"));
  assert.ok(report.failedCriteria.includes("independent_sessions"));
  assert.match(report.evidence.coverage, /considered 40 of 40 reviewed rows/);
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
    const report = buildReport(recommendationFixture());
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
    assert.equal(job.report.analyses.calibration.rows, 1);
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
    assert.match(retained.report.evidence.coverage, /considered 1 of 1 reviewed rows/);
    assert.equal(retained.report.evidence.missingVectorDiagnostics[0].reason, "unknown");
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

test("unaligned reviewed row uses the player's recording timebase and stays diagnostic", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { runJob } = require("../../src/helpers/speakerInAppCalibration");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speaker-resolved-row-"));
  const modelPath = path.join(dir, "model.onnx");
  fs.writeFileSync(modelPath, "fixture model");
  const origin = 1_700_000_000_000;
  const row = {
    id: "reviewed",
    source: "system",
    speaker: "split-1",
    speakerName: "Ada",
    speakerLockSource: "user",
    timebase: "epoch",
    recordingId: 1,
    recordingOrigin: origin,
    timestamp: origin + 5_000,
    speechStart: origin + 2_000,
    speechEnd: origin + 5_000,
  };
  const note = {
    id: 1,
    transcript: JSON.stringify([row]),
    speaker_action_log: null,
    created_at: "2026-10-01",
  };
  const wav = Buffer.alloc(44 + 3 * 24000 * 2);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  wav.writeUInt32LE(24000, 24);
  const spans = [];
  const writes = [];
  let state = "complete";
  const database = {
    db: { prepare: () => ({ all: () => [note] }) },
    getNoteSpeakerEmbeddings: () => [],
    getSpeakerProfiles: () => [
      { id: 1, display_name: "Ada", embedding: Buffer.from(new Float32Array([1, 0]).buffer) },
      { id: 2, display_name: "Ben", embedding: Buffer.from(new Float32Array([0, 1]).buffer) },
    ],
    saveSpeakerProfile: () => writes.push("profile"),
    saveVoiceExemplar: () => writes.push("exemplar"),
    saveNoteSpeakerEmbeddings: () => writes.push("centroid"),
  };
  const audioStore = {
    status: () => ({
      state,
      startedAt: origin,
      recordingId: 1,
      tracks: {
        system: { sampleCount: 240000, chunks: [{ startSample: 0, sampleCount: 240000 }] },
      },
    }),
    span: (...args) => {
      spans.push(args);
      return { wav, bytesRead: wav.length };
    },
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
    await runJob(retained, database, audioStore, { kind: "all" }, { notes: 1, rows: 400 }, model);
    assert.equal(retained.progress.reembeddedRows, 1);
    assert.equal(retained.report.analyses.calibration.rows, 1);
    assert.equal(retained.report.evidence.exactClusters, 0);
    assert.equal(retained.report.evidence.reconstructedRows, 1);
    assert.equal(retained.report.evidence.exclusions.length, 0);
    assert.deepEqual(spans[0].slice(0, 2), [1, "system"]);
    assert.ok(spans[0][2] <= 2 && spans[0][3] >= 5);
    assert.deepEqual(writes, []);
    state = "expired";
    const expired = job();
    await runJob(expired, database, audioStore, { kind: "all" }, { notes: 1, rows: 400 }, model);
    assert.equal(expired.progress.reembeddedRows, 0);
    assert.equal(expired.report.evidence.exclusions[0].reason, "audio_expired");
    state = "complete";
    note.transcript = JSON.stringify([{ ...row, speechEnd: origin + 2_700 }]);
    const short = job();
    await runJob(short, database, audioStore, { kind: "all" }, { notes: 1, rows: 400 }, model);
    assert.equal(short.progress.reembeddedRows, 0);
    assert.equal(short.report.evidence.exclusionCounts.span_too_short, 1);
    note.transcript = JSON.stringify([
      {
        ...row,
        timestamp: origin + 15_000,
        speechStart: origin + 12_000,
        speechEnd: origin + 15_000,
      },
    ]);
    const outside = job();
    await runJob(outside, database, audioStore, { kind: "all" }, { notes: 1, rows: 400 }, model);
    assert.equal(outside.progress.reembeddedRows, 0);
    assert.equal(outside.report.evidence.exclusionCounts.playback_outside_recorded_range, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a 576 row labelled note reports the 400 row budget and evaluates only considered rows", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { runJob } = require("../../src/helpers/speakerInAppCalibration");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speaker-capped-"));
  const modelPath = path.join(dir, "model.onnx");
  fs.writeFileSync(modelPath, "fixture model");
  const origin = 1_700_000_000_000;
  const note = {
    id: 62,
    created_at: "2026-10-01",
    speaker_action_log: null,
    transcript: JSON.stringify(
      Array.from({ length: 576 }, (_, i) => ({
        id: `row-${i}`,
        source: "system",
        speaker: "speaker-1",
        speakerName: "Ada",
        speakerLockSource: "user",
        timebase: "epoch",
        recordingId: 62,
        recordingOrigin: origin,
        timestamp: origin + (i * 3 + 2) * 1000,
        speechStart: origin + i * 3000,
        speechEnd: origin + (i * 3 + 2) * 1000,
      }))
    ),
  };
  const wav = Buffer.alloc(44 + 2 * 24000 * 2);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  wav.writeUInt32LE(24000, 24);
  const database = {
    db: { prepare: () => ({ all: () => [note] }) },
    getNoteSpeakerEmbeddings: () => [],
    getSpeakerProfiles: () => [
      { id: 1, display_name: "Ada", embedding: Buffer.from(new Float32Array([1, 0]).buffer) },
      { id: 2, display_name: "Ben", embedding: Buffer.from(new Float32Array([0, 1]).buffer) },
    ],
  };
  const audioStore = {
    status: () => ({
      state: "complete",
      startedAt: origin,
      recordingId: 62,
      tracks: {
        system: {
          sampleCount: 1800 * 24000,
          chunks: [{ startSample: 0, sampleCount: 1800 * 24000 }],
        },
      },
    }),
    span: () => ({ wav, bytesRead: wav.length }),
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
    await runJob(job, database, audioStore, { kind: "all" }, { notes: 1, rows: 400 }, model);
    assert.equal(job.progress.reembeddedRows, 400);
    assert.equal(job.report.analyses.calibration.rows, 400);
    assert.equal(job.report.evidence.exactClusters, 0);
    assert.equal(job.report.evidence.reviewedCandidates, 576);
    assert.equal(job.report.evidence.consideredRows, 400);
    assert.equal(job.report.evidence.truncatedByRowBudget, true);
    assert.equal(
      job.report.evidence.coverage,
      "considered 400 of 576 reviewed rows in 1 selected note (row budget 400, note budget 1; row cap truncated the set); 400 reconstructed"
    );
    assert.deepEqual(job.report.evidence.placementCounts, {
      exact: 0,
      approximate: 400,
      unavailable: 0,
    });
    assert.deepEqual(job.report.evidence.embeddingCounts, { embedded: 400, refused: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
