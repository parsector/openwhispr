const fs = require("node:fs");
const { randomUUID } = require("node:crypto");

// Guess values until the owner explicitly applies a report from reviewed audio.
const DEFAULTS = Object.freeze({
  similarityFloor: 0.65,
  runnerUpMargin: 0.03,
  minimumVoicedSeconds: 1.6,
  overlapToleranceSeconds: 0.1,
});
const LIMITS = {
  similarityFloor: [0, 1],
  runnerUpMargin: [0, 1],
  minimumVoicedSeconds: [0.1, 10],
  overlapToleranceSeconds: [0, 1],
};
let file = null;
let state = {
  values: { ...DEFAULTS },
  status: "uncalibrated",
  statuses: Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, "uncalibrated"])),
  evidence: null,
};

function current() {
  return structuredClone(state);
}
function validStoredEvidence(evidence) {
  return (
    evidence?.method === "stored-centroid-current-profiles" &&
    typeof evidence.reportId === "string" &&
    /^[a-f0-9-]{36}$/i.test(evidence.reportId) &&
    evidence.scope &&
    evidence.reviewedRows >= 30 &&
    evidence.notes >= 3 &&
    evidence.distinctPeople >= 2 &&
    evidence.machineClaims >= 10 &&
    evidence.exactClusters >= 12 &&
    Array.isArray(evidence.revisions) &&
    evidence.revisions.length === evidence.reviewedRows &&
    Array.isArray(evidence.exclusions) &&
    evidence.exclusions.every((item) => typeof item.reason === "string" && item.reason) &&
    /^[a-f0-9]{64}$/i.test(evidence.fingerprints?.model || "") &&
    /^[a-f0-9]{64}$/i.test(evidence.fingerprints?.profiles || "") &&
    Object.values(evidence.fingerprints?.audio || {}).some((hash) => /^[a-f0-9]{64}$/i.test(hash))
  );
}
function configure(destination) {
  file = destination;
  state = {
    values: { ...DEFAULTS },
    status: "uncalibrated",
    statuses: Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, "uncalibrated"])),
    evidence: null,
  };
  if (!file || !fs.existsSync(file)) return current();
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    validate(saved.values);
    const evidenceValid = validStoredEvidence(saved.evidence);
    const statuses = Object.fromEntries(
      Object.keys(DEFAULTS).map((key) => [
        key,
        evidenceValid &&
        saved.statuses?.[key] === "calibrated" &&
        saved.evidence.support?.[key]?.status === "calibrated"
          ? "calibrated"
          : "uncalibrated",
      ])
    );
    state = {
      values: saved.values,
      status: Object.values(statuses).some((status) => status === "calibrated")
        ? "calibrated"
        : "uncalibrated",
      statuses,
      evidence: evidenceValid ? saved.evidence : null,
    };
  } catch {
    /* corrupt local setting keeps documented guesses */
  }
  return current();
}
function validate(values) {
  if (
    !values ||
    Object.keys(LIMITS).some(
      (key) =>
        !Number.isFinite(values[key]) ||
        values[key] < LIMITS[key][0] ||
        values[key] > LIMITS[key][1]
    )
  )
    throw Error("Invalid speaker decision thresholds");
}
function apply(values, report = null) {
  validate(values);
  const validReport =
    report?.version === 2 &&
    report?.synthetic === false &&
    report?.method === "stored-centroid-current-profiles" &&
    typeof report.id === "string" &&
    /^[a-f0-9-]{36}$/i.test(report.id) &&
    report.scope &&
    report.evidence?.reviewedRows >= 30 &&
    report.evidence?.notes >= 3 &&
    report.evidence?.distinctPeople >= 2 &&
    report.evidence?.machineClaims >= 10 &&
    report.evidence?.exactClusters >= 12 &&
    Array.isArray(report.evidence.revisions) &&
    report.evidence.revisions.length === report.evidence.reviewedRows &&
    Array.isArray(report.evidence.exclusions) &&
    report.evidence.exclusions.every((item) => typeof item.reason === "string" && item.reason) &&
    /^[a-f0-9]{64}$/i.test(report.fingerprints?.model || "") &&
    /^[a-f0-9]{64}$/i.test(report.fingerprints?.profiles || "") &&
    Object.values(report.fingerprints?.audio || {}).some((hash) => /^[a-f0-9]{64}$/i.test(hash)) &&
    report.analyses?.exact?.label === "Measured against your profiles as they are today";
  const statuses = Object.fromEntries(
    Object.keys(LIMITS).map((key) => [
      key,
      validReport &&
      ["similarityFloor", "runnerUpMargin"].includes(key) &&
      report.support?.[key]?.status === "calibrated" &&
      report.support[key].method === "exact" &&
      report.support[key].rows >= 12 &&
      report.support[key].machineClaims >= 10 &&
      report.recommended?.[key] === values[key]
        ? "calibrated"
        : "uncalibrated",
    ])
  );
  const next = {
    values: Object.fromEntries(Object.keys(LIMITS).map((key) => [key, values[key]])),
    status: Object.values(statuses).some((status) => status === "calibrated")
      ? "calibrated"
      : "uncalibrated",
    statuses,
    evidence: validReport
      ? {
          reportId: report.id,
          method: report.method,
          scope: report.scope,
          ...report.evidence,
          fingerprints: report.fingerprints,
          support: report.support,
        }
      : null,
  };
  if (file) {
    const temp = `${file}.${randomUUID()}.pending`;
    try {
      fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
  state = next;
  return current();
}
function restore(previous) {
  validate(previous.values);
  const next = structuredClone(previous);
  if (file) {
    const temp = `${file}.${randomUUID()}.pending`;
    try {
      fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
  state = next;
  return current();
}
function effectiveFloor() {
  return state.statuses.similarityFloor === "calibrated" ? state.values.similarityFloor : 0.6;
}
module.exports = { DEFAULTS, configure, current, apply, restore, effectiveFloor };
