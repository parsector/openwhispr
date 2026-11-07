const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { runJobLocal } = require("../../src/helpers/speakerInAppCalibration");
const { buildReport } = require("../../src/helpers/speakerInAppCalibration");
const { recommendationFixture } = require("../lib/speakerRecommendationFixture");
const { reportStillCurrentLocal } = require("../../src/helpers/speakerInAppCalibration");

function boundedFixture(t) {
  const directory = fs.mkdtempSync(path.join(__dirname, "../../node_modules/.cache/bounded-gaps-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const modelPath = path.join(directory, "model");
  fs.writeFileSync(modelPath, "fixture model");
  const note = {
    id: 1,
    transcript: JSON.stringify([
      {
        id: "reviewed",
        source: "system",
        speaker: "1",
        speakerName: "Ada",
        speakerLockSource: "user",
        audioSpan: { recordingId: 1, trackId: "system", startSample: 240000, endSample: 336000 },
      },
    ]),
  };
  const wav = Buffer.alloc(44 + 4 * 24000 * 2);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  wav.writeUInt32LE(24000, 24);
  const database = {
    db: { prepare: () => ({ all: () => [note] }) },
    getNote: () => note,
    getNoteSpeakerEmbeddings: () => [
      { speaker_id: "1", embedding: Buffer.from(new Float32Array([0, 1]).buffer) },
    ],
    getSpeakerProfiles: () => [
      { id: 1, display_name: "Ada", embedding: Buffer.from(new Float32Array([1, 0]).buffer) },
      { id: 2, display_name: "Ben", embedding: Buffer.from(new Float32Array([0, 1]).buffer) },
    ],
  };
  const audioStore = {
    status: () => ({
      state: "complete",
      recordingId: 1,
      tracks: { system: { chunks: [{ startSample: 0, sampleCount: 40 * 24000 }] } },
    }),
    recordingProvenance: () => ({
      noteId: 1,
      recordingId: "9aabbcc0-0000-4000-8000-000000000001",
      status: "complete",
      tracks: { system: { chunks: [{ file: "retained.opus" }] } },
    }),
    span: () => ({ wav }),
  };
  const model = {
    isAvailable: () => true,
    getModelPath: () => modelPath,
    extractEmbeddingFromSamples: async () => new Float32Array([1, 0]),
  };
  const run = async () => {
    const job = {
      state: "running",
      progress: { processedRows: 0, reembeddedRows: 0, bytesRead: 0 },
    };
    await runJobLocal(job, database, audioStore, { kind: "all" }, { rows: 10, notes: 2 }, model);
    return job.report;
  };
  return { note, wav, database, audioStore, model, run };
}

test("gap 1: bounded reconstruction replaces a contradictory stored centroid", async (t) => {
  const f = boundedFixture(t);
  const report = await f.run();
  assert.equal(report.analyses.calibration.winner.right, 1);
  assert.equal(report.analyses.calibration.winner.wrong, 0);
  assert.equal(report.evidence.reconstructedRows, 1);
  f.model.extractEmbeddingFromSamples = async () => null;
  const unavailable = await f.run();
  assert.equal(unavailable.evidence.reviewedRows, 0);
  assert.equal(unavailable.evidence.exclusionCounts.embedding_unavailable, 1);
});

test("gap 1: a stored centroid without verified source intervals cannot enter a bounded report", () => {
  const input = recommendationFixture();
  input.rows.forEach((row) => {
    row.vectorSource = "stored-centroid-current-profiles";
  });
  const report = buildReport(input);
  assert.equal(report.evidence.reviewedRows, 0);
  assert.equal(report.evidence.exclusionCounts.bounded_vector_unavailable, 40);
});

test("gap 1: failed bounded extraction excludes the row without using its centroid", async (t) => {
  const f = boundedFixture(t);
  f.model.extractEmbeddingFromSamples = async () => {
    throw Error("extraction failed");
  };
  const report = await f.run();
  assert.equal(report.evidence.reviewedRows, 0);
  assert.equal(report.evidence.exclusionCounts.embedding_unavailable, 1);
});

test("gap 2: every conflicting cluster member is excluded before admission and bindings", () => {
  const input = recommendationFixture();
  input.rows.forEach((row, i) => {
    row.machineLabel = i < 10 ? row.truePerson : null;
    if (i < 10) {
      row.noteId = 99;
      row.clusterId = "conflict";
    }
  });
  const report = buildReport(input);
  assert.equal(report.resultType, "diagnostic_only");
  assert.equal(report.evidence.machineClaims, 0);
  assert.equal(report.evidence.reviewedRows, 30);
  assert.equal(report.evidence.exclusionCounts.conflicting_reviewed_labels, 10);
  assert.equal(report.evidence.exclusions.filter((row) => row.noteId === 99).length, 10);
  assert.ok(report.evidence.revisions.every((row) => row.noteId !== 99));
  assert.equal(Object.keys(report.fingerprints.audio).length, 30);
});

test("gap 4: freshness rejects missing or rebound row hashes and changed reconstructed bytes", async (t) => {
  const f = boundedFixture(t);
  const report = await f.run();
  assert.equal(await reportStillCurrentLocal(report, f.database, f.audioStore, f.model), true);
  const empty = structuredClone(report);
  empty.fingerprints.audio = {};
  assert.equal(await reportStillCurrentLocal(empty, f.database, f.audioStore, f.model), false);
  const rebound = structuredClone(report);
  rebound.evidence.revisions[0].rowId = "other";
  assert.equal(await reportStillCurrentLocal(rebound, f.database, f.audioStore, f.model), false);
  f.wav.writeInt16LE(17, 44);
  assert.equal(await reportStillCurrentLocal(report, f.database, f.audioStore, f.model), false);
});

test("gap 4: unused note centroids do not invalidate bounded evidence", async (t) => {
  const f = boundedFixture(t);
  const report = await f.run();
  f.database.getNoteSpeakerEmbeddings = () => [];
  assert.equal(await reportStillCurrentLocal(report, f.database, f.audioStore, f.model), true);
  assert.deepEqual(report.fingerprints.noteEmbeddings, {});
});

test("gap 4: changing reconstructed bytes with an unchanged manifest invalidates freshness", async (t) => {
  const f = boundedFixture(t);
  const report = await f.run();
  f.wav.writeInt16LE(17, 44);
  assert.equal(await reportStillCurrentLocal(report, f.database, f.audioStore, f.model), false);
});

test("gap 4: a fully excluded note leaves no embedding dependency", async (t) => {
  const f = boundedFixture(t);
  const rows = JSON.parse(f.note.transcript);
  delete rows[0].audioSpan;
  rows[0].timestamp = 20;
  f.note.transcript = JSON.stringify(rows);
  const report = await f.run();
  assert.equal(report.evidence.reviewedRows, 0);
  f.database.getNoteSpeakerEmbeddings = () => [];
  assert.equal(await reportStillCurrentLocal(report, f.database, f.audioStore, f.model), true);
});

test("gap 4: apply and reload reject a row identity rebound to an existing hash", (t) => {
  const config = require("../../src/helpers/speakerDecisionThresholds");
  const directory = fs.mkdtempSync(
    path.join(__dirname, "../../node_modules/.cache/freshness-boundary-")
  );
  t.after(() => {
    config.configure(null);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, "settings.json");
  config.configure(file);
  const report = buildReport(recommendationFixture());
  const values = { ...config.DEFAULTS, ...report.recommended };
  assert.equal(config.apply(values, report).status, "calibrated");
  const saved = JSON.parse(fs.readFileSync(file));
  saved.evidence.revisions[0].rowId = "rebound";
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.equal(config.configure(file).status, "uncalibrated");
  report.evidence.revisions[0].rowId = "rebound";
  assert.equal(config.apply(values, report).status, "uncalibrated");
});

test("gap 5: failing one exemplar does not exclude another clip sharing its first row", () => {
  const input = recommendationFixture();
  const base = {
    ...input.rows[0],
    timingProvenance: "retained_exemplar_clip",
    vectorSource: "approved-exemplar",
  };
  input.rows = [
    { ...base, exemplarId: "failed-clip" },
    { ...base, exemplarId: "good-clip" },
  ];
  const { evidenceFingerprintKey } = require("../../src/helpers/speakerCalibrationPolicy");
  input.exclusions = [
    {
      noteId: base.noteId,
      rowId: base.rowId,
      exemplarId: "failed-clip",
      evidenceKey: evidenceFingerprintKey(input.rows[0]),
      reason: "exemplar_integrity_failed",
    },
  ];
  const report = buildReport(input);
  assert.equal(report.evidence.savedExemplars, 2);
  assert.equal(report.evidence.exemplarRows, 1);
  assert.equal(report.analyses.calibration.rows, 1);
  assert.equal(report.evidence.revisions[0].exemplarId, "good-clip");
  assert.equal(report.evidence.exclusions.length, 1);
});

test("gap 5: the job preserves the healthy clip when sibling exemplar playback fails", async () => {
  const f = await require("../lib/calibrationLivenessFixture").fixture(34, 2);
  try {
    const [bad, good] = f.database.getVoiceExemplarAudio();
    f.database.db
      .prepare("UPDATE voice_exemplar_audio SET note_id=?, note_identity=?, row_ids=? WHERE id=?")
      .run(bad.note_id, bad.note_identity, bad.row_ids, good.id);
    const provenance = f.database.db
      .prepare("SELECT recording_id FROM voice_evidence_provenance WHERE sample_id=?")
      .get(bad.id);
    f.database.db
      .prepare("UPDATE voice_evidence_provenance SET recording_id=? WHERE sample_id=?")
      .run(provenance.recording_id, good.id);
    f.database.db
      .prepare("UPDATE voice_exemplar_audio SET ciphertext=? WHERE id=?")
      .run(Buffer.alloc(1), bad.id);
    const job = {
      state: "running",
      progress: { processedRows: 0, reembeddedRows: 0, bytesRead: 0 },
    };
    await runJobLocal(job, f.database, f.store, { kind: "all" }, { notes: 34, rows: 2 }, f.model);
    assert.equal(job.report.evidence.savedExemplars, 2);
    assert.equal(job.report.evidence.exemplarRows, 1);
    assert.equal(job.report.evidence.exclusions.length, 1);
    assert.equal(job.report.evidence.exclusions[0].exemplarId, bad.id);
    assert.equal(job.report.evidence.revisions[0].exemplarId, good.id);
    assert.equal(await reportStillCurrentLocal(job.report, f.database, f.store, f.model), true);
  } finally {
    f.close();
  }
});

test("gap 6: zero included evidence fails availability without alleging fingerprint corruption", () => {
  const input = recommendationFixture();
  input.rows.forEach((row) => {
    row.timingProvenance = "onset_only";
  });
  const report = buildReport(input);
  assert.ok(report.failedCriteria.includes("audio_evidence"));
  assert.ok(!report.failedCriteria.includes("audio_fingerprints"));
  assert.deepEqual(report.evidence.fingerprintIntegrity, []);
  assert.equal(report.resultType, "diagnostic_only");
  assert.deepEqual(report.recommended, {});
});
