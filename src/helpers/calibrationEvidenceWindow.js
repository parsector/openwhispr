// Playback may offer approximate coordinates. Calibration requires a bounded
// labelled interval contained in the retained audio selected for measurement.
function windowExclusion(row) {
  if (row.timingProvenance === "retained_exemplar_clip") return null;
  if (!["exact_stored_span", "capture_bounds"].includes(row.timingProvenance))
    return `window_${row.timingProvenance || "unavailable"}`;
  const unavailable = row.playbackUnavailableReason || row.unavailableReason;
  if (unavailable) return `playback_${unavailable}`;
  if (
    ![row.start, row.end, row.from, row.to].every(Number.isFinite) ||
    row.start < 0 ||
    row.from < 0 ||
    row.end <= row.start ||
    row.from > row.start ||
    row.to < row.end
  )
    return "window_label_not_contained";
  return null;
}

module.exports = { windowExclusion };
