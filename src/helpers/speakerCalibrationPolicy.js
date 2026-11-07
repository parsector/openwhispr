// Admission policy only; these constants do not change recognition or sweep scoring.
const { windowExclusion } = require("./calibrationEvidenceWindow");
const RECOMMENDATION_POLICY = Object.freeze({
  minimumReviewedRows: 30,
  minimumNotes: 3,
  minimumPeople: 2,
  minimumProfiles: 2,
  minimumMachineClaims: 10,
  minimumAnalysisRows: 12,
  // Product targets set by the owner (2026-11-05), not statistically derived.
  // Configurable through the admission policy; valid targets are in (0, 1].
  minimumCorrectNameCoverage: 0.7,
  minimumPrecision: 0.9,
});

const fingerprint = (value) => /^[a-f0-9]{64}$/.test(value || "");
const target = (value) => Number.isFinite(value) && value > 0 && value <= 1;
const session = (value) => typeof value === "string" && value.trim().length > 0;
const ADMISSION_CRITERIA = Object.freeze([
  "real_evidence",
  "reviewed_rows",
  "notes",
  "people",
  "profiles",
  "machine_claims",
  "analysis_rows",
  "model_fingerprint",
  "profile_fingerprint",
  "audio_evidence",
  "audio_fingerprints",
  "production_parity",
  "independent_sessions",
  "positive_coverage",
  "negative_coverage",
  "nonempty_accepted_set",
  "correct_name_coverage",
  "precision",
]);

// A clip and a reconstructed interval are different evidence, even in one note.
function evidenceFingerprintKey(row) {
  return JSON.stringify([
    row.noteId,
    row.exemplarId ?? null,
    row.rowId,
    row.track ?? null,
    row.start ?? null,
    row.end ?? null,
  ]);
}
function fingerprintIntegrity(rows, audioFingerprints) {
  return rows.flatMap((row) => {
    const verified = audioFingerprints[evidenceFingerprintKey(row)];
    const reason = !row.audioFingerprint
      ? "missing_fingerprint"
      : !fingerprint(row.audioFingerprint)
        ? "invalid_fingerprint"
        : !fingerprint(verified)
          ? "unverified_fingerprint"
          : row.audioFingerprint !== verified
            ? "fingerprint_mismatch"
            : null;
    return reason
      ? [
          {
            noteId: row.noteId,
            rowId: row.rowId,
            ...(row.exemplarId ? { exemplarId: row.exemplarId } : {}),
            evidenceKey: evidenceFingerprintKey(row),
            reason,
          },
        ]
      : [];
  });
}

// Reports, applied settings and reloads must bind the same complete row identity
// to exactly one verified hash. Extra, missing and duplicate bindings are stale.
function validRowEvidence(evidence, fingerprints) {
  const rows = evidence?.revisions;
  const audio = fingerprints?.audio;
  if (
    evidence?.audioFingerprintScope !== "row" ||
    !Array.isArray(rows) ||
    rows.length !== evidence.reviewedRows ||
    !audio ||
    typeof audio !== "object" ||
    Array.isArray(audio)
  )
    return false;
  if (
    !rows.every(
      (row) =>
        row &&
        row.noteId != null &&
        typeof row.rowId === "string" &&
        row.rowId &&
        typeof row.revision === "string" &&
        row.revision &&
        row.evidenceKey === evidenceFingerprintKey(row) &&
        !windowExclusion(row)
    )
  )
    return false;
  const keys = rows.map(evidenceFingerprintKey);
  return (
    new Set(keys).size === rows.length &&
    Object.keys(audio).length === rows.length &&
    keys.every((key) => Object.hasOwn(audio, key)) &&
    fingerprintIntegrity(rows, audio).length === 0
  );
}

function admitRecommendation({
  rows,
  profiles,
  synthetic,
  modelFingerprint,
  profileFingerprint,
  audioFingerprints,
  analysis,
  validationEvidence,
  policy = RECOMMENDATION_POLICY,
}) {
  const notes = new Set(rows.map((row) => row.noteId));
  const names = new Set(profiles.map((profile) => profile.name));
  const tuningSessions = [...new Set(rows.map((row) => row.recordingSessionId).filter(session))];
  // Holdout observations must come from production at the frozen candidate policy.
  // The current reconstruction job cannot supply these. No vectors are replayed here.
  const observations = Array.isArray(validationEvidence?.observations)
    ? validationEvidence.observations
    : [];
  const evaluationSessions = [
    ...new Set(observations.map((row) => row.recordingSessionId).filter(session)),
  ];
  const validObservations =
    observations.length > 0 &&
    observations.every(
      (row) =>
        session(row.recordingSessionId) &&
        (row.truePerson === null ||
          (typeof row.truePerson === "string" && row.truePerson.length > 0)) &&
        (row.predictedPerson === null || names.has(row.predictedPerson))
    );
  const positives = observations.filter((row) => names.has(row.truePerson)).length;
  const negatives = observations.length - positives;
  const accepted = observations.filter((row) => row.predictedPerson != null).length;
  const right = observations.filter(
    (row) => row.predictedPerson != null && row.predictedPerson === row.truePerson
  ).length;
  const validation = {
    rows: observations.length,
    positives,
    negatives,
    accepted,
    right,
    wrong: accepted - right,
    refused: observations.length - accepted,
    // Coverage penalizes refusals on enrolled people; precision includes all
    // accepted names, including false accepts on negative examples.
    correctNameCoverage: positives ? right / positives : null,
    precision: accepted ? right / accepted : null,
  };
  const checks = {
    real_evidence: !synthetic,
    reviewed_rows: rows.length >= policy.minimumReviewedRows,
    notes: notes.size >= policy.minimumNotes,
    people: new Set(rows.map((row) => row.truePerson).filter(Boolean)).size >= policy.minimumPeople,
    profiles: profiles.length >= policy.minimumProfiles,
    machine_claims: rows.filter((row) => row.machineLabel).length >= policy.minimumMachineClaims,
    analysis_rows: analysis.rows >= policy.minimumAnalysisRows,
    model_fingerprint: fingerprint(modelFingerprint),
    profile_fingerprint: fingerprint(profileFingerprint),
    audio_evidence: rows.length > 0,
    audio_fingerprints: fingerprintIntegrity(rows, audioFingerprints).length === 0,
    production_parity:
      validObservations &&
      validationEvidence?.source === "production-decisions" &&
      validationEvidence.modelFingerprint === modelFingerprint &&
      validationEvidence.profileFingerprint === profileFingerprint &&
      validationEvidence.policy?.similarityFloor === analysis.winner.similarityFloor &&
      validationEvidence.policy?.runnerUpMargin === analysis.winner.runnerUpMargin,
    independent_sessions:
      validObservations &&
      tuningSessions.length > 0 &&
      rows.every((row) => session(row.recordingSessionId)) &&
      evaluationSessions.every((id) => !tuningSessions.includes(id)),
    positive_coverage: positives > 0,
    negative_coverage: negatives > 0,
    nonempty_accepted_set: analysis.winner.right + analysis.winner.wrong > 0 && accepted > 0,
    correct_name_coverage:
      target(policy.minimumCorrectNameCoverage) &&
      validation.correctNameCoverage >= policy.minimumCorrectNameCoverage,
    precision: target(policy.minimumPrecision) && validation.precision >= policy.minimumPrecision,
  };
  return {
    policy: { ...policy },
    failedCriteria: ADMISSION_CRITERIA.filter((key) => !checks[key]),
    validation: { ...validation, checks },
    evidenceScope: {
      tuningSessions,
      evaluationSessions,
      evaluationSource: validationEvidence?.source || null,
    },
    uncertainty: [
      validObservations ? "finite_holdout" : "no_production_validation",
      "current_profiles_only",
      "duration_overlap_not_evaluated",
    ],
  };
}

// Used at application and reload boundaries as well as by the report builder.
function hasSupportedAdmission(result) {
  const checks = result?.validation?.checks;
  return (
    result?.resultType === "supported_recommendation" &&
    Array.isArray(result.failedCriteria) &&
    result.failedCriteria.length === 0 &&
    checks &&
    ADMISSION_CRITERIA.every((key) => checks[key] === true) &&
    result.validation.accepted > 0 &&
    result.validation.right > 0 &&
    target(result.policy?.minimumCorrectNameCoverage) &&
    target(result.policy?.minimumPrecision) &&
    result.validation.correctNameCoverage >= result.policy.minimumCorrectNameCoverage &&
    result.validation.precision >= result.policy.minimumPrecision
  );
}

module.exports = {
  RECOMMENDATION_POLICY,
  evidenceFingerprintKey,
  fingerprintIntegrity,
  validRowEvidence,
  ADMISSION_CRITERIA,
  admitRecommendation,
  hasSupportedAdmission,
};
