const test = require("node:test");
const assert = require("node:assert/strict");
const { evidenceIndex, intervalIndex } = require("../../src/helpers/calibrationEvidenceIndex");
const { overlapsRecording } = require("../../src/helpers/voiceRecordingIdentity");

test("indexed approval suppression preserves the original identity, track and interval rules", () => {
  const recording = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const samples = Array.from({ length: 90 }, (_, i) => ({
    id: `s${i}`,
    note_id: (i % 3) + 1,
    note_identity: i % 4 ? `note-${(i % 3) + 1}` : null,
    row_ids: JSON.stringify([`r${i}`]),
    track: i % 2 ? "mic" : "system",
    start_sample: (i % 7) * 24000,
    end_sample: ((i % 7) + 3) * 24000,
  }));
  const classify = (s) =>
    Number(s.id.slice(1)) % 3
      ? { state: "resolved", recordingId: recording(s.note_id) }
      : { state: "pending_recovery" };
  samples.push({ ...samples[0], id: "s90", start_sample: NaN });
  samples.push({ ...samples[1], id: "s91", end_sample: NaN });
  const db = {
    prepare: () => ({
      get: (id) => {
        const p = classify(samples.find((s) => s.id === id));
        return p.state === "resolved" ? { state: p.state, recording_id: p.recordingId } : p;
      },
    }),
  };
  const indexed = evidenceIndex(samples, classify);
  for (let n = 1; n <= 4; n++)
    for (const resolved of [false, true]) {
      const note = { id: n, client_note_id: `note-${n}` };
      const provenance = resolved
        ? { state: "resolved", recordingId: recording(n) }
        : { state: "pending_recovery" };
      const store = {
        recordingProvenance: () =>
          resolved
            ? {
                noteId: n,
                noteIdentity: note.client_note_id,
                status: "complete",
                recordingId: recording(n),
                hasSourceAudio: true,
              }
            : null,
      };
      for (const track of ["mic", "system"])
        for (let r = 0; r < 100; r++) {
          const label = { rowId: `r${r}`, track, from: r % 10, to: (r % 10) + 1 };
          const expected = samples.some(
            (s) =>
              (s.note_id === n &&
                s.note_identity === note.client_note_id &&
                JSON.parse(s.row_ids).includes(label.rowId)) ||
              overlapsRecording(db, s, note, store, track, label.from * 24000, label.to * 24000)
          );
          assert.equal(indexed(note, provenance, label), expected);
        }
    }
  assert.equal(
    indexed(
      { id: 99, client_note_id: "none" },
      { state: "unrecoverable" },
      { rowId: "none", track: "mic", from: 1, to: 2 }
    ),
    false
  );
});

test("chunk index returns every overlapping interval, including nested duplicates", () => {
  const items = [
    { a: 0, b: 100 },
    { a: 2, b: 3 },
    { a: 2, b: 3 },
    { a: 50, b: 60 },
  ];
  const index = intervalIndex(
    items,
    (x) => x.a,
    (x) => x.b
  );
  for (let start = 0; start < 110; start++)
    assert.deepEqual(
      index.select(start, start + 1),
      items.filter((x) => x.a < start + 1 && x.b > start)
    );
});
