const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

test("a supported exact report calibrates each supported threshold and routes the naming floor", () => {
  const config = require("../../src/helpers/speakerDecisionThresholds");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speaker-threshold-test-"));
  const file = path.join(dir, "thresholds.json");
  try {
    config.configure(file);
    const values = {
      similarityFloor: 0.75,
      runnerUpMargin: 0.08,
      minimumVoicedSeconds: 1.6,
      overlapToleranceSeconds: 0.1,
    };
    const support = Object.fromEntries(
      ["similarityFloor", "runnerUpMargin"].map((key) => [
        key,
        { status: "calibrated", method: "exact", rows: 12, machineClaims: 10 },
      ])
    );
    const report = {
      version: 2,
      id: "fefaa286-3893-4865-886e-ddc475255311",
      synthetic: false,
      method: "stored-centroid-current-profiles",
      scope: { kind: "all" },
      evidence: {
        notes: 3,
        reviewedRows: 30,
        distinctPeople: 2,
        machineClaims: 10,
        exactClusters: 12,
        revisions: Array.from({ length: 30 }, (_, i) => ({ noteId: i % 3, rowId: i })),
        exclusions: [],
      },
      fingerprints: {
        model: "a".repeat(64),
        profiles: "b".repeat(64),
        audio: { 0: "c".repeat(64), 1: "d".repeat(64), 2: "e".repeat(64) },
      },
      analyses: { exact: { label: "Measured against your profiles as they are today" } },
      support,
      recommended: { similarityFloor: 0.75, runnerUpMargin: 0.08 },
    };
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
