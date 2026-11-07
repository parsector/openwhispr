// The transcript player, calibration export and voice enrolment use the same
// recording timebase and retained-chunk boundaries.
const RATE = 24000;
const MARGIN = 0.04;
const UNKNOWN_ONSET_WINDOW = 10;

function seconds(value, startedAt) {
  if (value == null || !Number.isFinite(value)) return null;
  return value > 1e12 ? (startedAt == null ? null : (value - startedAt) / 1000) : value;
}

// Bulk readers reuse next-row and recorded-region indexes. A range-max tree
// finds the first later onset above the resolver's existing tolerance, including
// out-of-order/split rows, without scanning the rest of the transcript per row.
function createMeetingAudioSpanContext(rows, recordingId, startedAt, tracks) {
  const positions = new Map();
  rows.forEach((row, i) => {
    if (!positions.has(row.id)) positions.set(row.id, i);
  });
  const trees = new Map();
  const regionsByTrack = new Map();
  for (const track of ["mic", "system"]) {
    let size = 1;
    while (size < rows.length) size *= 2;
    const tree = new Float64Array(size * 2).fill(-Infinity);
    rows.forEach((candidate, i) => {
      if (
        candidate.source !== track ||
        (candidate.recordingId != null && candidate.recordingId !== recordingId)
      )
        return;
      const span = candidate.audioSpan;
      const value =
        span && span.recordingId === recordingId && span.trackId === track
          ? span.startSample / RATE
          : seconds(candidate.speechStart, startedAt);
      if (value != null && Number.isFinite(value)) tree[size + i] = value;
    });
    for (let i = size - 1; i > 0; i--) tree[i] = Math.max(tree[i * 2], tree[i * 2 + 1]);
    trees.set(track, { tree, size });
    const regions = [];
    for (const chunk of tracks?.[track]?.chunks || []) {
      const lower = chunk.startSample / RATE,
        upper = (chunk.startSample + chunk.sampleCount) / RATE;
      const last = regions.at(-1);
      if (last && lower <= last.to) last.to = Math.max(last.to, upper);
      else regions.push({ from: lower, to: upper });
    }
    regionsByTrack.set(track, regions);
  }
  return {
    nextStart(row, start, track) {
      const position = positions.get(row.id);
      if (position == null) return null;
      const { tree, size } = trees.get(track);
      const search = (node, from, to) => {
        if (
          to <= position + 1 ||
          tree[node] < start - UNKNOWN_ONSET_WINDOW ||
          tree[node] === -Infinity
        )
          return null;
        if (to - from === 1) return tree[node];
        const mid = (from + to) >>> 1;
        return search(node * 2, from, mid) ?? search(node * 2 + 1, mid, to);
      };
      return search(1, 0, size);
    },
    regions: (track) => regionsByTrack.get(track),
  };
}

function resolveMeetingAudioSpan(row, rows, recordingId, startedAt, tracks, context = null) {
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
  const index = context ? -1 : rows.findIndex((candidate) => candidate.id === row.id);
  const nextStart = context
    ? context.nextStart(row, start, track)
    : index < 0
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
    const regions = context ? context.regions(track) : [];
    for (const chunk of context ? [] : chunks) {
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

export { resolveMeetingAudioSpan, createMeetingAudioSpanContext, RATE, MARGIN };
