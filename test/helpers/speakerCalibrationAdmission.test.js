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

test("independent production holdout with owner targets supports a recommendation", () => {
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
  assert.equal(report.validation.checks.precision, false);
  assert.deepEqual(report.failedCriteria, [
    "nonempty_accepted_set",
    "correct_name_coverage",
    "precision",
  ]);
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

test("default admission policy uses the owner's product targets", () => {
  const input = recommendationFixture();
  delete input.policy;
  const report = buildReport(input);
  assert.equal(report.resultType, "supported_recommendation");
  assert.deepEqual(report.policy, RECOMMENDATION_POLICY);
  assert.equal(report.policy.minimumCorrectNameCoverage, 0.7);
  assert.equal(report.policy.minimumPrecision, 0.9);
});

for (const [right, admitted] of [
  [89, false],
  [90, true],
]) {
  test(`precision ${(right / 100).toFixed(2)} is ${admitted ? "admitted" : "rejected"} with all other criteria satisfied`, () => {
    const input = recommendationFixture();
    input.validationEvidence.observations = Array.from({ length: 100 }, (_, i) => ({
      recordingSessionId: "holdout-boundary",
      truePerson: i < right ? "Ada" : null,
      predictedPerson: "Ada",
    }));
    const report = buildReport(input);
    assert.equal(report.validation.precision, right / 100);
    assert.equal(report.validation.correctNameCoverage, 1);
    assert.deepEqual(report.failedCriteria, admitted ? [] : ["precision"]);
    assert.equal(report.resultType, admitted ? "supported_recommendation" : "diagnostic_only");
    assert.equal(hasSupportedAdmission(report), admitted);
  });
}

for (const [right, admitted] of [
  [69, false],
  [70, true],
]) {
  test(`correct-name coverage ${(right / 100).toFixed(2)} is ${admitted ? "admitted" : "rejected"} with all other criteria satisfied`, () => {
    const input = recommendationFixture();
    input.validationEvidence.observations = [
      ...Array.from({ length: 100 }, (_, i) => ({
        recordingSessionId: "holdout-boundary",
        truePerson: "Ada",
        predictedPerson: i < right ? "Ada" : null,
      })),
      { recordingSessionId: "holdout-negative", truePerson: null, predictedPerson: null },
    ];
    const report = buildReport(input);
    assert.equal(report.validation.correctNameCoverage, right / 100);
    assert.equal(report.validation.precision, 1);
    assert.deepEqual(report.failedCriteria, admitted ? [] : ["correct_name_coverage"]);
    assert.equal(report.resultType, admitted ? "supported_recommendation" : "diagnostic_only");
    assert.equal(hasSupportedAdmission(report), admitted);
  });
}

test("product admission targets remain configurable", () => {
  const input = recommendationFixture();
  input.validationEvidence.observations[0].predictedPerson = null;
  input.policy.minimumCorrectNameCoverage = 0.5;
  const report = buildReport(input);
  assert.equal(report.resultType, "supported_recommendation");
  assert.equal(report.policy.minimumCorrectNameCoverage, 0.5);
  assert.equal(hasSupportedAdmission(report), true);
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

for (const kind of ["two clips", "clip and reconstructed window"]) {
  test(`different verified fingerprints in one note admit ${kind}`, () => {
    const input = recommendationFixture();
    input.rows[0] = {
      ...input.rows[0],
      exemplarId: "clip-a",
      vectorSource: "approved-exemplar",
      timingProvenance: "retained_exemplar_clip",
    };
    input.rows[1] = {
      ...input.rows[1],
      audioFingerprint: "c".repeat(64),
      verifiedAudioFingerprint: "c".repeat(64),
      ...(kind === "two clips"
        ? {
            exemplarId: "clip-b",
            vectorSource: "approved-exemplar",
            timingProvenance: "retained_exemplar_clip",
          }
        : {
            vectorSource: "reconstructed-row-audio",
            track: "system",
            start: 10,
            end: 14,
            from: 10,
            to: 14,
          }),
    };
    const report = buildReport(input);
    assert.equal(report.failedCriteria.includes("audio_fingerprints"), false);
    assert.equal(report.resultType, "supported_recommendation");
    assert.equal(Object.keys(report.fingerprints.audio).length, 40);
    assert.deepEqual(report.evidence.fingerprintIntegrity, []);
  });
}

test("missing, invalid, unverified and mismatched row fingerprints remain integrity failures", () => {
  for (const [reason, change] of [
    ["missing_fingerprint", { audioFingerprint: null }],
    ["invalid_fingerprint", { audioFingerprint: "broken" }],
    ["unverified_fingerprint", { verifiedAudioFingerprint: null }],
    ["fingerprint_mismatch", { verifiedAudioFingerprint: "c".repeat(64) }],
  ]) {
    const input = recommendationFixture();
    Object.assign(input.rows[0], change);
    const report = rejects(input, "audio_fingerprints");
    assert.equal(report.evidence.fingerprintIntegrity[0].reason, reason);
    assert.equal(report.evidence.fingerprintIntegrity[0].rowId, "row-0");
  }
});
