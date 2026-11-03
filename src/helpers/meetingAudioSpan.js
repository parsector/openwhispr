// The transcript player, calibration export and voice enrolment use the same
// recording timebase and retained-chunk boundaries.
const RATE = 24000;
const MARGIN = 0.04;
const UNKNOWN_ONSET_WINDOW = 10;

function seconds(value, startedAt) {
  if (value == null || !Number.isFinite(value)) return null;
  return value > 1e12 ? (startedAt == null ? null : (value - startedAt) / 1000) : value;
}

function resolveMeetingAudioSpan(row, rows, recordingId, startedAt, tracks) {
  const span = row.audioSpan;
  const validSpan = !!span && span.recordingId === recordingId;
  const track = row.source;
  if (
    !["mic", "system"].includes(track) ||
    (row.recordingId != null && row.recordingId !== recordingId) ||
    (row.recordingOrigin != null && row.recordingOrigin !== startedAt) ||
    (row.timebase === "epoch" && row.timestamp != null && row.timestamp < 1e12) ||
    (row.timebase === "recording" &&
      (row.recordingId == null || (row.timestamp != null && row.timestamp > 1e12))) ||
    (!validSpan && (row.timestamp == null || (row.timestamp > 1e12 && startedAt == null))) ||
    (row.timebase == null &&
      startedAt != null &&
      row.timestamp != null &&
      row.timestamp < 1e12 &&
      !validSpan)
  )
    return { reason: "timebase" };
  if (validSpan && span.trackId !== track) return { reason: "track_mismatch" };

  const completion = seconds(row.timestamp, startedAt);
  const onset = seconds(row.speechStart, startedAt);
  const speechEnd = seconds(row.speechEnd, startedAt);
  const start = validSpan
    ? span.startSample / RATE
    : (onset ?? Math.max(0, (completion ?? 0) - UNKNOWN_ONSET_WINDOW));
  const end = validSpan
    ? span.endSample / RATE
    : (speechEnd ?? completion ?? start + UNKNOWN_ONSET_WINDOW);
  const details = { start, end, track, approximate: !validSpan };
  const anchor = validSpan ? start : (onset ?? completion ?? start);
  const index = rows.findIndex((candidate) => candidate.id === row.id);
  const nextStart =
    index < 0
      ? null
      : rows
          .slice(index + 1)
          .filter(
            (candidate) =>
              candidate.source === track &&
              (candidate.recordingId == null || candidate.recordingId === recordingId)
          )
          .map((candidate) =>
            candidate.audioSpan &&
            candidate.audioSpan.recordingId === recordingId &&
            candidate.audioSpan.trackId === track
              ? candidate.audioSpan.startSample / RATE
              : seconds(candidate.speechStart, startedAt)
          )
          .find(
            (value) =>
              value != null && Number.isFinite(value) && value >= start - UNKNOWN_ONSET_WINDOW
          );
  let from = Math.max(0, Math.round((start - MARGIN) * 1000) / 1000);
  let to = Math.round(Math.min(end + MARGIN, nextStart ?? Infinity) * 1000) / 1000;
  if (tracks) {
    const chunks = tracks[track]?.chunks || [];
    const regions = [];
    for (const chunk of chunks) {
      const lower = chunk.startSample / RATE;
      const upper = (chunk.startSample + chunk.sampleCount) / RATE;
      const last = regions.at(-1);
      if (last && lower <= last.to) last.to = Math.max(last.to, upper);
      else regions.push({ from: lower, to: upper });
    }
    const containing = regions.find((region) => region.from <= anchor && region.to > anchor);
    if (!containing) {
      const recordedEnd =
        tracks[track]?.sampleCount != null
          ? tracks[track].sampleCount / RATE
          : Math.max(0, ...chunks.map((chunk) => (chunk.startSample + chunk.sampleCount) / RATE));
      return {
        ...details,
        reason: anchor < 0 || anchor >= recordedEnd ? "outside_recorded_range" : "gap",
      };
    }
    from = Math.round(Math.max(from, containing.from) * 1000) / 1000;
    to = Math.round(Math.min(to, containing.to) * 1000) / 1000;
  }
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from)
    return { ...details, reason: "gap" };
  return { ...details, from, to, reason: null };
}

module.exports = { resolveMeetingAudioSpan, RATE, MARGIN };
