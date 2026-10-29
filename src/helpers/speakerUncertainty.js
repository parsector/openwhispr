// Reasons are emitted only when the corresponding measurement exists. Keep the
// row payload open-ended so later analyzers can add evidence without migration.
function matchReason(best, runnerUp) {
  if (!best) return null;
  if (runnerUp && best.score - runnerUp.score < 0.03) {
    return { reason: "close_match", candidates: [best.name, runnerUp.name] };
  }
  if (best.score <= 0.6) return { reason: "not_sure" };
  return null;
}

function shortSpanReason(span) {
  return span && Number.isFinite(span.start) && Number.isFinite(span.end) && span.end - span.start < 1.6
    ? { reason: "too_short" } : null;
}

function changedAfterFinalReason(priorName, finalName) {
  return priorName && finalName && priorName !== finalName
    ? { reason: "changed_after_final" } : null;
}

module.exports = { matchReason, shortSpanReason, changedAfterFinalReason };
