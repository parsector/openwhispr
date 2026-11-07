const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCalibrationLabels } = require("../../src/helpers/speakerCalibrationExport");

test("gap 3: export names finite fallback windows as unusable for calibration", () => {
  const labels = buildCalibrationLabels(
    {
      id: 1,
      transcript: JSON.stringify([
        { id: "fallback", source: "system", timestamp: 20, speakerName: "Ada" },
      ]),
    },
    {},
    {
      recordingId: 1,
      tracks: { system: { chunks: [{ startSample: 0, sampleCount: 30 * 24000 }] } },
    }
  );
  assert.equal(labels.rows[0].timingProvenance, "completion_timestamp_fallback");
  assert.equal(labels.rows[0].calibrationExclusionReason, "window_completion_timestamp_fallback");
});

test("export preserves retained samples when WAV silence can hide a rounded boundary", () => {
  const track = {
    sampleCount: 240000,
    chunks: [{ file: "private.opus", startSample: 0, sampleCount: 72013 },
      { file: "later.opus", startSample: 96000, sampleCount: 144000 }],
  };
  const labels = buildCalibrationLabels({ id: 1, transcript: JSON.stringify([{
    id: "boundary", source: "system",
    audioSpan: { recordingId: 1, trackId: "system", startSample: 24000, endSample: 72000 },
  }]) }, { system: { file: "system.wav" } }, { recordingId: 1, tracks: { system: track } });
  assert.deepEqual(labels.audio.system, {
    file: "system.wav",
    retainedTrack: { sampleCount: 240000, chunks: [
      { startSample: 0, sampleCount: 72013 }, { startSample: 96000, sampleCount: 144000 },
    ] },
  });
  assert.equal(labels.rows[0].to, 3.001);
  assert.equal(labels.rows[0].calibrationExclusionReason, "window_retained_coverage");
});
