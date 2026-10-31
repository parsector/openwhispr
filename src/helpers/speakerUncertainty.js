const { current } = require("./speakerDecisionThresholds");
// Reasons are emitted only when the corresponding measurement exists. Keep the
// row payload open-ended so later analyzers can add evidence without migration.
function matchReason(best, runnerUp) {
  if (!best) return null;
  if (runnerUp && best.score - runnerUp.score < current().values.runnerUpMargin) {
    return { reason: "close_match", candidates: [best.name, runnerUp.name] };
  }
  // This uncertainty-only default is another guess until owner calibration.
  if (best.score <= (current().status === 'calibrated' ? current().values.similarityFloor : 0.6))
    return { reason: "not_sure" };
  return null;
}

function shortSpanReason(span) {
  return span && Number.isFinite(span.start) && Number.isFinite(span.end) && span.end - span.start < current().values.minimumVoicedSeconds
    ? { reason: "too_short" } : null;
}

function changedAfterFinalReason(priorName, finalName) {
  return priorName && priorName !== finalName
    ? { reason: "changed_after_final" } : null;
}

module.exports = { matchReason, shortSpanReason, changedAfterFinalReason };
