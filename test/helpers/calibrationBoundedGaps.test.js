const createTempDir = require("../lib/tempDir");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { runJobLocal } = require("../../src/helpers/speakerInAppCalibration");
const { buildReport } = require("../../src/helpers/speakerInAppCalibration");
const { recommendationFixture } = require("../lib/speakerRecommendationFixture");
const { reportStillCurrentLocal } = require("../../src/helpers/speakerInAppCalibration");

function boundedFixture(t) {
  const directory = createTempDir(path.join(__dirname, "../../node_modules/.cache/bounded-gaps-"));
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
  const run = async (budget = { rows: 10, notes: 2 }) => {
    const job = {
      state: "running",
      progress: { processedRows: 0, reembeddedRows: 0, bytesRead: 0 },
    };
    await runJobLocal(job, database, audioStore, { kind: "all" }, budget, model);
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
  const directory = createTempDir(
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

test("freshness sees a newly reviewed conflicting sibling without an included-row edit", async (t) => {
  const f = boundedFixture(t);
  const [r1] = JSON.parse(f.note.transcript);
  r1.id = "r1";
  f.note.transcript = JSON.stringify([r1]);
  const report = await f.run();
  assert.equal(report.evidence.reviewedRows, 1);
  assert.equal(await reportStillCurrentLocal(report, f.database, f.audioStore, f.model), true);
  const missingMembership = structuredClone(report);
  missingMembership.evidence.reviewedClusterMembership = "{}";
  assert.equal(await reportStillCurrentLocal(missingMembership, f.database, f.audioStore, f.model), false);
  f.note.transcript = JSON.stringify([
    r1,
    {
      ...r1,
      id: "r2",
      speakerName: "Ben",
      audioSpan: { ...r1.audioSpan, startSample: 384000, endSample: 480000 },
    },
  ]);
  const rebuilt = await f.run();
  assert.equal(rebuilt.evidence.reviewedRows, 0);
  assert.equal(rebuilt.evidence.exclusionCounts.conflicting_reviewed_labels, 2);
  assert.deepEqual(rebuilt.evidence.exclusions.map((row) => row.rowId), ["r1", "r2"]);
  assert.equal(await reportStillCurrentLocal(report, f.database, f.audioStore, f.model), false);
});

test("measurement rejects a stored span one sample shorter than 1.5 seconds", async (t) => {
  const f = boundedFixture(t);
  const [row] = JSON.parse(f.note.transcript);
  row.audioSpan = { ...row.audioSpan, startSample: 24001, endSample: 60000 };
  f.note.transcript = JSON.stringify([row]);
  const { buildCalibrationLabels } = require("../../src/helpers/speakerCalibrationExport");
  const { windowExclusion } = require("../../src/helpers/calibrationEvidenceWindow");
  const label = buildCalibrationLabels(f.note, {}, f.audioStore.status()).rows[0];
  assert.equal((await f.run()).evidence.exclusionCounts.span_too_short, 1);
  assert.equal(windowExclusion(label), "span_too_short");
});

for (const [name, startSample, endSample, from, to, reason] of [
  ["a 120-second label with margins", 24000, 2904000, 0.96, 121.04, "audio_invalid"],
  ["a measurement window below 120 seconds", 24000, 2902056, 0.96, 120.959, null],
  ["a measurement window at 120 seconds", 24000, 2902080, 0.96, 120.96, null],
  ["a measurement window above 120 seconds", 24000, 2902104, 0.96, 120.961, "audio_invalid"],
  ["an exact 36000-sample label", 12005, 48005, 0.46, 2.04, null],
  ["a 35994-sample label", 12005, 47999, 0.46, 2.04, "span_too_short"],
  ["a 35999-sample label at the same onset", 12005, 48004, 0.46, 2.04, "span_too_short"],
  ["another 35999-sample label", 24001, 60000, 0.96, 2.54, "span_too_short"],
]) {
  test(`measurement parity: ${name}`, async (t) => {
    const f = boundedFixture(t);
    const { MeetingAudioStore, RATE } = require("../../src/helpers/meetingAudioStore");
    const store = new MeetingAudioStore(path.dirname(f.model.getModelPath()), {
      encryption: { encryptBytes: (bytes) => bytes, decryptBytes: (bytes) => bytes },
      codec: require("../lib/fakeAudioCodec"),
    });
    store.begin(1);
    store.append(1, "system", Buffer.alloc(123 * RATE * 2));
    store.finish(1);
    const status = store.status(1);
    const [row] = JSON.parse(f.note.transcript);
    row.audioSpan = { recordingId: status.recordingId, trackId: "system", startSample, endSample };
    f.note.transcript = JSON.stringify([row]);
    const { buildCalibrationLabels } = require("../../src/helpers/speakerCalibrationExport");
    const { windowExclusion, measurementInterval } = require("../../src/helpers/calibrationEvidenceWindow");
    const label = buildCalibrationLabels(f.note, {}, status).rows[0];
    assert.deepEqual([label.from, label.to], [from, to]);
    const interval = measurementInterval(label);
    const span = store.span(1, "system", interval.from, interval.to);
    assert.equal(span.state, reason === "audio_invalid" ? "invalid" : "available");
    Object.assign(f.audioStore, {
      status: () => status,
      recordingProvenance: (...args) => store.recordingProvenance(...args),
      span: (...args) => store.span(...args),
    });
    const report = await f.run();
    assert.equal(report.evidence.reviewedRows, reason ? 0 : 1);
    assert.deepEqual(report.evidence.exclusions.map(({ reason }) => reason), reason ? [reason] : []);
    assert.equal(label.calibrationExclusionReason, reason);
    assert.equal(windowExclusion(label, status.tracks.system), reason);
  });
}

test("measurement preserves the seconds-based capture-bounds minimum", () => {
  const { windowExclusion } = require("../../src/helpers/calibrationEvidenceWindow");
  assert.equal(windowExclusion({
    timingProvenance: "capture_bounds", start: 12005 / 24000, end: 48005 / 24000,
    from: 0.46, to: 2.04,
  }), "span_too_short");
});

test("measurement rejects a resolved window rounded past retained samples", async (t) => {
  const f = boundedFixture(t);
  const [row] = JSON.parse(f.note.transcript);
  row.audioSpan = { ...row.audioSpan, startSample: 24000, endSample: 72000 };
  f.note.transcript = JSON.stringify([row]);
  const track = { sampleCount: 72013, chunks: [{ startSample: 0, sampleCount: 72013 }] };
  const status = { ...f.audioStore.status(), tracks: { system: track } };
  f.audioStore.status = () => status;
  const { buildCalibrationLabels } = require("../../src/helpers/speakerCalibrationExport");
  const { windowExclusion } = require("../../src/helpers/calibrationEvidenceWindow");
  const label = buildCalibrationLabels(f.note, {}, status).rows[0];
  assert.equal(label.from, 0.96);
  assert.equal(label.to, 3.001);
  assert.equal(windowExclusion(label, track), "window_retained_coverage");
  // The stub decoder would supply bytes; validation must reject before calling it.
  f.audioStore.span = () => assert.fail("uncovered interval reached the decoder");
  assert.equal((await f.run()).evidence.exclusionCounts.window_retained_coverage, 1);
});

test("freshness ignores siblings outside selection or bounded embedding eligibility", async (t) => {
  const f = boundedFixture(t);
  const [r1] = JSON.parse(f.note.transcript);
  const report = await f.run();
  const limited = await f.run({ rows: 1, notes: 2 });
  const sibling = {
    ...r1,
    id: "sibling",
    speakerName: "Ben",
    audioSpan: { ...r1.audioSpan, startSample: 384000, endSample: 480000 },
  };
  f.note.transcript = JSON.stringify([r1, sibling]);
  assert.equal(await reportStillCurrentLocal(limited, f.database, f.audioStore, f.model), true);
  f.note.transcript = JSON.stringify([r1, { ...sibling, speakerLockSource: "machine" }]);
  assert.equal(await reportStillCurrentLocal(report, f.database, f.audioStore, f.model), true);
  f.note.transcript = JSON.stringify([
    r1, { ...sibling, audioSpan: undefined, timestamp: 20 },
  ]);
  assert.equal(await reportStillCurrentLocal(report, f.database, f.audioStore, f.model), true);
  f.note.transcript = JSON.stringify([r1, { ...sibling, speaker: "unrelated" }]);
  f.model.extractEmbeddingFromSamples = () => assert.fail("unrelated evidence was measured");
  assert.equal(await reportStillCurrentLocal(report, f.database, f.audioStore, f.model), true);
  f.note.transcript = JSON.stringify([r1, sibling]);
  f.model.extractEmbeddingFromSamples = async () => null;
  assert.equal(await reportStillCurrentLocal(report, f.database, f.audioStore, f.model), true);
  assert.equal((await f.run()).evidence.exclusionCounts.conflicting_reviewed_labels, undefined);
});

test("freshness rechecks the measurement interval resolved for an unchanged reviewed row", async (t) => {
  const f = boundedFixture(t);
  const [row] = JSON.parse(f.note.transcript);
  const origin = 1700000000000;
  delete row.audioSpan;
  Object.assign(row, {
    timebase: "epoch", recordingId: 1,
    speechStart: origin + 10000, speechEnd: origin + 14000, timestamp: origin + 14000,
  });
  f.note.transcript = JSON.stringify([row]);
  const status = { ...f.audioStore.status(), startedAt: origin };
  f.audioStore.status = () => status;
  const report = await f.run();
  assert.equal(report.evidence.reviewedRows, 1);
  assert.equal(await reportStillCurrentLocal(report, f.database, f.audioStore, f.model), true);
  status.startedAt -= 1000;
  const rebuilt = await f.run();
  assert.notEqual(rebuilt.evidence.revisions[0].start, report.evidence.revisions[0].start);
  assert.equal(await reportStillCurrentLocal(report, f.database, f.audioStore, f.model), false);
});
