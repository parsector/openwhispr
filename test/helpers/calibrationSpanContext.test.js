const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveMeetingAudioSpan,
  createMeetingAudioSpanContext,
} = require("../../src/helpers/meetingAudioSpan.mjs");

test("bulk span lookup matches player timing for split, out-of-order, foreign and legacy rows", () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({
    id: `row-${i}`,
    source: i % 3 ? "mic" : "system",
    recordingId: i % 7 ? undefined : "foreign",
    timestamp: i * 2 + 2,
    speechStart: i % 11 ? i * 2 : i,
    ...(i % 5
      ? {
          audioSpan: {
            recordingId: "recording",
            trackId: i % 3 ? "mic" : "system",
            startSample: (i % 9 ? i * 2 : i) * 24000,
            endSample: (i * 2 + 2) * 24000,
          },
        }
      : {}),
  }));
  const tracks = {
    mic: { sampleCount: 1000 * 24000, chunks: [{ startSample: 0, sampleCount: 1000 * 24000 }] },
    system: {
      sampleCount: 1000 * 24000,
      chunks: [
        { startSample: 0, sampleCount: 100 * 24000 },
        { startSample: 150 * 24000, sampleCount: 850 * 24000 },
      ],
    },
  };
  for (const recording of [undefined, "recording", "other"]) {
    const context = createMeetingAudioSpanContext(rows, recording, 1700000000000, tracks);
    for (const row of rows)
      assert.deepEqual(
        resolveMeetingAudioSpan(row, rows, recording, 1700000000000, tracks, context),
        resolveMeetingAudioSpan(row, rows, recording, 1700000000000, tracks)
      );
  }
});

test("worker dependencies do not load unsupported Electron APIs", async () => {
  const { Worker } = require("node:worker_threads");
  const files = ["database", "meetingAudioStore", "voiceEnrollment", "speakerInAppCalibration"].map(
    (name) => require.resolve(`../../src/helpers/${name}`)
  );
  const worker = new Worker(
    `
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(request, parent, main) {
      if (request === 'electron') throw Error('Electron API loaded in worker');
      return load.call(this, request, parent, main);
    };
    for (const file of require('node:worker_threads').workerData) require(file);
  `,
    { eval: true, workerData: files }
  );
  await new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", (code) => (code === 0 ? resolve() : reject(Error(`Worker exit ${code}`))));
  });
});
