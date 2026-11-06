// Exact sample-space tiling. Boundary chunks may extend outside the requested
// span, but every sample inside it must have precisely one owner.
function exactCoverage(chunks, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start)
    return false;
  const intervals = [];
  for (const chunk of chunks) {
    if (
      !Number.isSafeInteger(chunk.startSample) ||
      chunk.startSample < 0 ||
      !Number.isSafeInteger(chunk.sampleCount) ||
      chunk.sampleCount <= 0 ||
      !Number.isSafeInteger(chunk.startSample + chunk.sampleCount)
    )
      return false;
    const from = Math.max(start, chunk.startSample);
    const to = Math.min(end, chunk.startSample + chunk.sampleCount);
    if (to > from) intervals.push([from, to]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let cursor = start;
  for (const [from, to] of intervals) {
    if (from !== cursor) return false;
    cursor = to;
  }
  return cursor === end;
}

// One millisecond accommodates persisted INTEGER duration rounding. Interval
// coverage itself has no tolerance. Canonical PCM has 24 samples per ms.
const DURATION_TOLERANCE_MS = 1;
function durationMatches(actualMs, expectedSamples) {
  return (
    Number.isFinite(actualMs) &&
    Number.isSafeInteger(expectedSamples) &&
    expectedSamples > 0 &&
    Math.abs(actualMs - expectedSamples / 24) <= DURATION_TOLERANCE_MS
  );
}

function integrityError() {
  return Object.assign(new Error("Approved audio source integrity failed"), {
    code: "source_integrity_failed",
  });
}

module.exports = { exactCoverage, durationMatches, integrityError };
