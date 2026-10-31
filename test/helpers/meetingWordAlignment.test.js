const test = require("node:test");
const assert = require("node:assert/strict");
const { alignTranscriptRows, timedWordsFromStoredTrack,
  withAudioSpans } = require("../../src/helpers/meetingWordAlignment");

test("audio-derived word timestamps align an existing row without rewriting its text or id", () => {
  const input = [{ id: "row-1", text: "Hello there.", source: "system" }];
  const result = alignTranscriptRows(input, [
    { text: "Hello", start: 1.2, end: 1.5 },
    { text: "there.", start: 1.6, end: 2.0 },
  ]);
  assert.equal(result[0].id, "row-1");
  assert.equal(result[0].text, "Hello there.");
  assert.deepEqual(result[0].wordTimings, [
    { word: "Hello", start: 1.2, end: 1.5 },
    { word: "there.", start: 1.6, end: 2.0 },
  ]);
});

test("a mismatched ASR transcript leaves the row unaligned", () => {
  const [row] = alignTranscriptRows([{ id: "row-1", text: "word not heard" }], [
    { text: "another", start: 1, end: 2 },
  ]);
  assert.equal(row.wordTimings, undefined);
  assert.equal(row.audioSpan, undefined);
});

test("retained mic audio is decoded in bounded windows with recording-relative word times", async () => {
  const requests = [];
  const words = await timedWordsFromStoredTrack({
    noteId: 7, track: "mic", durationSeconds: 175,
    store: { span: (_id, _track, start, end) => {
      requests.push([start, end]);
      return { state: "available", wav: Buffer.from(String(start)) };
    } },
    transcribe: async (wav) => ({ segments: Number(wav.toString()) === 0
      ? [{ text: "hello", start: 10, end: 11 }, { text: "edge", start: 89, end: 90 }]
      : [{ text: "hello", start: 10, end: 11 }] }),
  });
  assert.deepEqual(requests, [[0, 95], [85, 175]]);
  assert.deepEqual(words, [
    { text: "hello", start: 10, end: 11 },
    { text: "edge", start: 89, end: 90 },
    { text: "hello", start: 95, end: 96 },
  ]);
});

test("aligned rows get exact spans even when speaker diarization is disabled", () => {
  const rows = withAudioSpans([{ id: "a", source: "mic", text: "hello",
    wordTimings: [{ word: "hello", start: 2, end: 2.4 }] },
  { id: "b", source: "mic", text: "uncertain" }], 7, { mic: 0 });
  assert.deepEqual(rows[0].audioSpan, { recordingId: 7, trackId: "mic",
    startSample: 48000, endSample: 57600 });
  assert.equal(rows[1].audioSpan, undefined);
});
