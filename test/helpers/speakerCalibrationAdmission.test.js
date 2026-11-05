const test = require("node:test");
const assert = require("node:assert/strict");
const { buildReport } = require("../../src/helpers/speakerInAppCalibration");
const { recommendationFixture } = require("../lib/speakerRecommendationFixture");
const {
  RECOMMENDATION_POLICY,
  ADMISSION_CRITERIA,
  hasSupportedAdmission,
} = require("../../src/helpers/speakerCalibrationPolicy");

function rejects(input, criterion) {
  const report = buildReport(input);
  assert.equal(report.resultType, "diagnostic_only");
  assert.deepEqual(report.recommended, {});
  assert.ok(report.failedCriteria.includes(criterion), JSON.stringify(report.failedCriteria));
  assert.equal(report.validation.checks[criterion], false);
  assert.equal(hasSupportedAdmission(report), false);
  return report;
}

test("independent production holdout with declared targets supports a recommendation", () => {
  const report = buildReport(recommendationFixture());
  assert.equal(report.resultType, "supported_recommendation");
  assert.deepEqual(report.recommended, { similarityFloor: 0.75, runnerUpMargin: 0.1 });
  assert.deepEqual(report.failedCriteria, []);
  assert.deepEqual(Object.keys(report.validation.checks), ADMISSION_CRITERIA);
  assert.equal(report.validation.correctNameCoverage, 1);
  assert.equal(report.validation.precision, 1);
  assert.equal(report.validation.positives, 2);
  assert.equal(report.validation.negatives, 2);
  assert.ok(
    report.evidenceScope.evaluationSessions.every(
      (id) => !report.evidenceScope.tuningSessions.includes(id)
    )
  );
  assert.ok(report.uncertainty.includes("finite_holdout"));
  assert.ok(report.uncertainty.includes("duration_overlap_not_evaluated"));
  assert.equal(hasSupportedAdmission(report), true);
});

test("one machine claim fails the existing minimum even with an independent holdout", () => {
  const input = recommendationFixture();
  input.rows = input.rows.map((row, i) => ({ ...row, machineLabel: i === 0 ? "Ada" : null }));
  rejects(input, "machine_claims");
});

test("universal refusal cannot qualify even when independent validation would pass", () => {
  const input = recommendationFixture();
  input.rows = input.rows.map((row) => ({ ...row, vector: [-1, -1] }));
  const report = rejects(input, "nonempty_accepted_set");
  assert.equal(report.analyses.calibration.winner.refused, report.analyses.calibration.rows);
  assert.equal(report.validation.precision, 1);
});

test("empty accepted holdout cannot qualify regardless of the tuning winner", () => {
  const input = recommendationFixture();
  input.validationEvidence.observations = input.validationEvidence.observations.map((row) => ({
    ...row,
    predictedPerson: null,
  }));
  const report = rejects(input, "nonempty_accepted_set");
  assert.equal(report.validation.accepted, 0);
  assert.equal(report.validation.precision, null);
});

test("different notes from the same recording session cannot form an independent holdout", () => {
  const input = recommendationFixture();
  input.validationEvidence.observations[0].recordingSessionId = input.rows[0].recordingSessionId;
  rejects(input, "independent_sessions");
  input.validationEvidence.observations[0].recordingSessionId = "holdout-1";
  delete input.rows[0].recordingSessionId;
  rejects(input, "independent_sessions");
});

test("production parity requires production decisions at the frozen candidate and fingerprints", () => {
  for (const change of [
    (e) => {
      e.source = "reconstructed-row-audio";
    },
    (e) => {
      e.modelFingerprint = "c".repeat(64);
    },
    (e) => {
      e.profileFingerprint = "c".repeat(64);
    },
    (e) => {
      e.policy.runnerUpMargin = 0.03;
    },
  ]) {
    const input = recommendationFixture();
    change(input.validationEvidence);
    rejects(input, "production_parity");
  }
});

test("independent evaluation requires both enrolled positives and unenrolled negatives", () => {
  const positiveOnly = recommendationFixture();
  positiveOnly.validationEvidence.observations = positiveOnly.validationEvidence.observations.slice(
    0,
    2
  );
  rejects(positiveOnly, "negative_coverage");
  const negativeOnly = recommendationFixture();
  negativeOnly.validationEvidence.observations =
    negativeOnly.validationEvidence.observations.slice(2);
  rejects(negativeOnly, "positive_coverage");
});

test("correct-name coverage and precision are separate admission requirements", () => {
  const lowCoverage = recommendationFixture();
  lowCoverage.validationEvidence.observations[0].predictedPerson = null;
  const coverageReport = rejects(lowCoverage, "correct_name_coverage");
  assert.equal(coverageReport.validation.precision, 1);
  assert.equal(coverageReport.validation.correctNameCoverage, 0.5);
  const lowPrecision = recommendationFixture();
  lowPrecision.validationEvidence.observations[2].predictedPerson = "Ada";
  const precisionReport = rejects(lowPrecision, "precision");
  assert.equal(precisionReport.validation.correctNameCoverage, 1);
  assert.equal(precisionReport.validation.precision, 2 / 3);
});

test("unset product targets prevent admission rather than inventing goals", () => {
  const input = recommendationFixture();
  delete input.policy;
  const report = rejects(input, "declared_targets");
  assert.deepEqual(report.policy, RECOMMENDATION_POLICY);
  assert.equal(report.policy.minimumCorrectNameCoverage, null);
  assert.equal(report.policy.minimumPrecision, null);
});

test("each existing evidence minimum and fingerprint failure names itself", () => {
  for (const [criterion, mutate] of [
    [
      "real_evidence",
      (i) => {
        i.synthetic = true;
      },
    ],
    [
      "reviewed_rows",
      (i) => {
        i.rows = i.rows.slice(0, 29);
      },
    ],
    [
      "notes",
      (i) => {
        i.rows = i.rows.map((row) => ({ ...row, noteId: 1 }));
      },
    ],
    [
      "people",
      (i) => {
        i.rows = i.rows.map((row) => ({ ...row, truePerson: "Ada" }));
      },
    ],
    [
      "profiles",
      (i) => {
        i.profiles = i.profiles.slice(0, 1);
      },
    ],
    [
      "analysis_rows",
      (i) => {
        i.rows = i.rows.map((row) => ({ ...row, noteId: 1, clusterId: "1", truePerson: "Ada" }));
      },
    ],
    [
      "model_fingerprint",
      (i) => {
        i.modelFingerprint = "invalid";
      },
    ],
    [
      "audio_fingerprints",
      (i) => {
        i.rows[0].audioFingerprint = "invalid";
      },
    ],
  ]) {
    const input = recommendationFixture();
    mutate(input);
    rejects(input, criterion);
  }
});

test("diagnostic reports are rejected by the apply action even if a recommendation is injected", () => {
  const input = recommendationFixture();
  delete input.validationEvidence;
  const report = buildReport(input);
  report.recommended = { similarityFloor: 0.75, runnerUpMargin: 0.1 };
  const database = { db: { exec() {} } };
  assert.throws(
    () => require("../../src/helpers/speakerCalibrationAction").apply(database, report),
    /No supported/
  );
});
