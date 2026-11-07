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
