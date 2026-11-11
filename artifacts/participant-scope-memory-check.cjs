// Supplemental bounded-batch check; decoding/model inference are intentionally
// stubbed. Run: node --expose-gc --import tsx artifacts/participant-scope-memory-check.cjs
const assert = require("node:assert/strict");
const scopeHelper = require("../src/helpers/noteSpeakerScope");
const { resolveSpeakerRoster } = require("../src/helpers/speakerRosterPolicy");
const { prepareSpeakerRowEvaluations } = require("../src/helpers/speakerRowEvaluation");
const child = require("node:child_process");
const originalExecFile = child.execFile;
const profile = {
  id: 1,
  display_name: "A",
  email: "a@example.com",
  voice_usable: 1,
  embedding: Float32Array.of(1, 0),
};
const note = { id: 42, participants: "[]" };
const rejected = scopeHelper.decision(resolveSpeakerRoster(note, null, [profile]), {
  path: "bounded_batch_check",
  rejectionReason: "no_match",
});
const rows = Array.from({ length: 2000 }, (_, i) => ({
  id: `memory-${i}`,
  speaker: "speaker_0",
  speakerDecision: rejected,
  audioSpan: { recordingId: 1, trackId: "system", startSample: 0, endSample: 96000 },
}));
let profileReads = 0;
const database = { getNote: () => ({ ...note, transcript: JSON.stringify(rows) }) };
const identifier = {
  getSpeakerProfiles: () => {
    profileReads++;
    return [profile];
  },
  matchEligibleCluster: (_id, _embedding, context) => ({
    profile,
    speakerDecision: scopeHelper.decision(context.scope, { path: "bounded_batch_check", profile }),
  }),
};
const audio = {
  status: () => ({ recordingId: 1 }),
  spanAsync: async () => ({ state: "available", wav: Buffer.alloc(64) }),
};
const extractor = {
  isAvailable: () => true,
  extractEmbeddingFromSamples: async () => new Float32Array(512),
};
child.execFile = (_file, _args, _options, callback) => {
  setImmediate(() => callback(null, Buffer.alloc(256)));
  return { stdin: { on() {}, end() {} } };
};
(async () => {
  assert.equal(typeof global.gc, "function", "run with --expose-gc");
  const discarded = [];
  for (let iteration = 0; iteration < 5; iteration++) {
    global.gc();
    const start = performance.now();
    let result = await prepareSpeakerRowEvaluations(
      database,
      identifier,
      42,
      null,
      [],
      audio,
      extractor
    );
    assert.equal(result.size, 2000);
    global.gc();
    const retained = process.memoryUsage();
    result = null;
    await new Promise((resolve) => setImmediate(resolve));
    global.gc();
    global.gc();
    const after = process.memoryUsage();
    discarded.push(after.heapUsed);
    console.log(
      JSON.stringify({
        iteration,
        rows: 2000,
        ms: +(performance.now() - start).toFixed(1),
        retainedHeapMiB: +(retained.heapUsed / 1048576).toFixed(2),
        discardedHeapMiB: +(after.heapUsed / 1048576).toFixed(2),
        externalMiB: +(after.external / 1048576).toFixed(2),
        profileReads,
      })
    );
  }
  assert.equal(profileReads, 5);
  assert.ok(discarded.at(-1) - discarded[1] < 8 * 1048576, "discarded batches must not accumulate");
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    child.execFile = originalExecFile;
  });
