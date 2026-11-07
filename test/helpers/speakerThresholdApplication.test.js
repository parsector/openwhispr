const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { recommendationFixture } = require("../lib/speakerRecommendationFixture");
const { buildReport } = require("../../src/helpers/speakerInAppCalibration");

test("recommendation is never applied until explicit settings save and synthetic data stays uncalibrated", () => {
  const config = require("../../src/helpers/speakerDecisionThresholds");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speaker-threshold-test-"));
  try {
    config.configure(path.join(dir, "thresholds.json"));
    const { matchReason } = require("../../src/helpers/speakerUncertainty");
    assert.equal(config.current().status, "uncalibrated");
    const proposed = {
      similarityFloor: 0.6,
      runnerUpMargin: 0.05,
      minimumVoicedSeconds: 2,
      overlapToleranceSeconds: 0.1,
    };
    assert.equal(config.current().values.similarityFloor, 0.65);
    assert.equal(matchReason({ score: 0.7, name: "A" }, { score: 0.66, name: "B" }), null);
    config.apply(proposed, { synthetic: true, audioSha256: { system: "fixture" } });
    assert.equal(config.current().status, "uncalibrated");
    assert.equal(config.current().values.similarityFloor, 0.6);
    assert.equal(
      matchReason({ score: 0.7, name: "A" }, { score: 0.66, name: "B" }).reason,
      "close_match"
    );
    config.apply(proposed, {
      version: 1,
      synthetic: false,
      audioSha256: { system: "a".repeat(64) },
      evidence: { rowCount: 20 },
    });
    assert.equal(config.current().status, "uncalibrated");
    assert.equal(config.current().statuses.similarityFloor, "uncalibrated");
    config.configure(path.join(dir, "thresholds.json"));
    assert.equal(config.current().values.runnerUpMargin, 0.05);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    config.configure(null);
  }
});

test("an independently validated report calibrates each supported threshold and routes the naming floor", () => {
  const config = require("../../src/helpers/speakerDecisionThresholds");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speaker-threshold-test-"));
  const file = path.join(dir, "thresholds.json");
  try {
    config.configure(file);
    const values = {
      similarityFloor: 0.75,
      runnerUpMargin: 0.1,
      minimumVoicedSeconds: 1.6,
      overlapToleranceSeconds: 0.1,
    };
    const report = buildReport(recommendationFixture());
    const applied = config.apply(values, report);
    assert.equal(applied.status, "calibrated");
    assert.equal(applied.statuses.similarityFloor, "calibrated");
    assert.equal(applied.statuses.runnerUpMargin, "calibrated");
    assert.equal(applied.statuses.minimumVoicedSeconds, "uncalibrated");
    assert.equal(applied.statuses.overlapToleranceSeconds, "uncalibrated");
    assert.equal(config.effectiveFloor(), 0.75);
    assert.equal(config.configure(file).statuses.similarityFloor, "calibrated");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    config.configure(null);
  }
});

test("a reconstructed diagnostic report cannot calibrate settings when applied or reloaded", () => {
  const config = require("../../src/helpers/speakerDecisionThresholds");
  const { buildReport } = require("../../src/helpers/speakerInAppCalibration");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speaker-reconstructed-threshold-"));
  const file = path.join(dir, "thresholds.json");
  try {
    config.configure(file);
    const report = buildReport({
      rows: Array.from({ length: 36 }, (_, i) => ({
        noteId: 1 + Math.floor(i / 12),
        rowId: `row-${i}`,
        revision: `revision-${i}`,
        truePerson: i % 2 ? "Ben" : "Ada",
        machineLabel: i % 2 ? "Ben" : "Ada",
        clusterId: `cluster-${i}`,
        vector: i % 2 ? [0, 1] : [1, 0],
        vectorSource: "reconstructed-row-audio",
        audioFingerprint: "a".repeat(64),
        verifiedAudioFingerprint: "a".repeat(64),
        timingProvenance: "exact_stored_span",
        start: 0,
        end: 2,
        from: 0,
        to: 2,
      })),
      profiles: [
        { id: 1, name: "Ada", vector: [1, 0] },
        { id: 2, name: "Ben", vector: [0, 1] },
      ],
      scope: { kind: "all" },
      modelFingerprint: "b".repeat(64),
    });
    const applied = config.apply({ ...config.DEFAULTS, ...report.recommended }, report);
    assert.equal(applied.statuses.similarityFloor, "uncalibrated");
    assert.equal(applied.evidence, null);
    assert.equal(config.configure(file).statuses.similarityFloor, "uncalibrated");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    config.configure(null);
  }
});

test("legacy applied settings retain their production values and status on reload", () => {
  const config = require("../../src/helpers/speakerDecisionThresholds");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speaker-legacy-threshold-"));
  const file = path.join(dir, "thresholds.json");
  try {
    config.configure(file);
    const report = buildReport(recommendationFixture());
    const applied = config.apply({ ...config.DEFAULTS, ...report.recommended }, report);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const key of [
      "resultType",
      "failedCriteria",
      "policy",
      "validation",
      "evidenceScope",
      "uncertainty",
    ])
      delete saved.evidence[key];
    fs.writeFileSync(file, JSON.stringify(saved));
    const restored = config.configure(file);
    assert.deepEqual(restored.values, applied.values);
    assert.deepEqual(restored.statuses, applied.statuses);
    assert.equal(config.effectiveFloor(), 0.75);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    config.configure(null);
  }
});
