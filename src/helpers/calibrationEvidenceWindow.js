// Playback may offer approximate coordinates. Calibration requires a bounded
// labelled interval contained in the retained audio selected for measurement.
const { exactCoverage } = require("./voiceAudioIntegrity");
const MEASUREMENT_RATE = 24000;
const MINIMUM_LABEL_SECONDS = 1.5;

// Keep the resolver's millisecond rounding. Both consumers then request its
// from/to window at the nearest canonical (24 kHz) sample, with no tolerance or
// clipping at the retained boundary. Resampling happens only after this slice.
function measurementInterval(row) {
  const startSample = Math.round(row.from * MEASUREMENT_RATE);
  const endSample = Math.round(row.to * MEASUREMENT_RATE);
  return {
    startSample,
    endSample,
    from: startSample / MEASUREMENT_RATE,
    to: endSample / MEASUREMENT_RATE,
  };
}

function windowExclusion(row, retainedTrack = row.retainedTrack) {
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
  // Recover exact stored endpoints before subtracting: seconds can make an
  // exactly 36,000-sample label appear shorter than 1.5 seconds.
  const tooShort = row.timingProvenance === "exact_stored_span"
    ? Math.round(row.end * MEASUREMENT_RATE) - Math.round(row.start * MEASUREMENT_RATE) <
      MINIMUM_LABEL_SECONDS * MEASUREMENT_RATE
    : row.end - row.start < MINIMUM_LABEL_SECONDS;
  if (tooShort) return "span_too_short";
  const { startSample, endSample, from, to } = measurementInterval(row);
  // Match the store's strict seconds comparison on the rounded request.
  if (to - from > 120) return "audio_invalid";
  if (
    retainedTrack &&
    ((retainedTrack.sampleCount != null && endSample > retainedTrack.sampleCount) ||
      !exactCoverage(retainedTrack.chunks || [], startSample, endSample))
  )
    return "window_retained_coverage";
  return null;
}

// The app and CLI slice source PCM first, then use the same sample-count and
// source-index flooring when converting that bounded interval to 16 kHz.
function pcm16Samples(pcm, sampleRate) {
  const count = Math.floor(pcm.length / 2);
  const result = new Float32Array(Math.floor((count * 16000) / sampleRate));
  for (let i = 0; i < result.length; i++)
    result[i] = pcm.readInt16LE(Math.floor((i * sampleRate) / 16000) * 2) / 32768;
  return result;
}

module.exports = { windowExclusion, measurementInterval, pcm16Samples, MEASUREMENT_RATE };
