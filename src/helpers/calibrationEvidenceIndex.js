// Index approvals once. Ineligible approvals still suppress transcript fallback.
// Prefix maxima preserve overlap semantics even for nested/duplicate intervals.
function intervalIndex(items, startOf, endOf) {
  const sorted = items
    .filter((item) => !Number.isNaN(Number(startOf(item))) && !Number.isNaN(Number(endOf(item))))
    .sort((a, b) => startOf(a) - startOf(b));
  const maxima = [];
  for (const item of sorted) maxima.push(Math.max(maxima.at(-1) ?? -Infinity, endOf(item)));
  return {
    overlaps(start, end) {
      if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
      let lo = 0,
        hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (startOf(sorted[mid]) < end) lo = mid + 1;
        else hi = mid;
      }
      return lo > 0 && maxima[lo - 1] > start;
    },
    select(start, end) {
      let lo = 0,
        hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (maxima[mid] <= start) lo = mid + 1;
        else hi = mid;
      }
      const result = [];
      for (let i = lo; i < sorted.length && startOf(sorted[i]) < end; i++)
        if (endOf(sorted[i]) > start) result.push(sorted[i]);
      return result;
    },
  };
}

function evidenceIndex(samples, classify) {
  const rows = new Set();
  const groups = new Map();
  const add = (key, sample) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  };
  const key = (...parts) =>
    JSON.stringify(parts.map((part) => (part === undefined ? { undefined: true } : part)));
  for (const sample of samples) {
    for (const rowId of JSON.parse(sample.row_ids))
      rows.add(key(sample.note_id, sample.note_identity, rowId));
    const prior = classify(sample);
    if (prior.state === "resolved") add(key("recording", prior.recordingId, sample.track), sample);
    else add(key("note", sample.note_id, sample.note_identity || null, sample.track), sample);
  }
  const indexes = new Map(
    [...groups].map(([k, items]) => [
      k,
      intervalIndex(
        items,
        (s) => s.start_sample,
        (s) => s.end_sample
      ),
    ])
  );
  return (note, provenance, label) =>
    rows.has(key(note.id, note.client_note_id, label.rowId)) ||
    [
      ...(provenance.state === "resolved"
        ? [key("recording", provenance.recordingId, label.track)]
        : []),
      key("note", note.id, null, label.track),
      ...(note.client_note_id ? [key("note", note.id, note.client_note_id, label.track)] : []),
    ].some((k) => indexes.get(k)?.overlaps(label.from * 24000, label.to * 24000));
}
module.exports = { evidenceIndex, intervalIndex };
