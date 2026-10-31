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
let state = { values: { ...DEFAULTS }, status: "uncalibrated", evidence: null };

function current() {
  return structuredClone(state);
}
function configure(destination) {
  file = destination;
  state = { values: { ...DEFAULTS }, status: "uncalibrated", evidence: null };
  if (!file || !fs.existsSync(file)) return current();
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    validate(saved.values);
    state = {
      values: saved.values,
      status: saved.status === "calibrated" ? "calibrated" : "uncalibrated",
      evidence: saved.evidence || null,
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
  const ownerEvidence =
    report &&
    report.synthetic === false &&
    report.version === 1 &&
    report.evidence?.rowCount > 0 &&
    Object.values(report.audioSha256 || {}).some(
      (hash) => typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash)
    );
  const next = {
    values: Object.fromEntries(Object.keys(LIMITS).map((key) => [key, values[key]])),
    status: ownerEvidence ? "calibrated" : "uncalibrated",
    evidence: ownerEvidence
      ? { audioSha256: report.audioSha256, rowCount: report.evidence.rowCount }
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
module.exports = { DEFAULTS, configure, current, apply };
