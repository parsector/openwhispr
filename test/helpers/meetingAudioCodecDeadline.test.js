const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const processes = require("node:child_process");

test("production codec spawns have deadlines; a stalled process is killed and the next decode succeeds", async (t) => {
  const load = Module._load;
  const syncOptions = [];
  let stall = true;
  Module._load = function (request, ...args) {
    if (request === "child_process")
      return {
        ...processes,
        spawnSync(file, argv, options) {
          syncOptions.push(options);
          return processes.spawnSync(file, argv, options);
        },
        execFile(file, argv, options, callback) {
          assert.ok(options.timeout > 0);
          assert.equal(options.killSignal, "SIGKILL");
          if (stall) {
            stall = false;
            return processes.execFile(
              process.execPath,
              ["-e", "setInterval(() => {}, 1000)"],
              options,
              callback
            );
          }
          return processes.execFile(file, argv, options, callback);
        },
      };
    return load.call(this, request, ...args);
  };
  let defaultCodec, CODEC_TIMEOUT_MS;
  try {
    ({ defaultCodec, CODEC_TIMEOUT_MS } = require("../../src/helpers/meetingAudioStore"));
  } finally {
    Module._load = load;
  }
  const pcm = Buffer.alloc(24000 * 2);
  const ogg = defaultCodec.encode(pcm);
  defaultCodec.decode(ogg);
  assert.equal(syncOptions.length, 2);
  assert.ok(
    syncOptions.every(
      (options) => options.timeout === CODEC_TIMEOUT_MS && options.killSignal === "SIGKILL"
    )
  );
  await assert.rejects(
    defaultCodec.decodeAsync(ogg, { timeout: 30 }),
    (error) => error.killed && error.signal === "SIGKILL"
  );
  const decoded = await defaultCodec.decodeAsync(ogg);
  assert.equal(decoded.length, pcm.length);
  t.diagnostic(
    `real stalled child: timeout=30ms signal=SIGKILL; next decode=${decoded.length} PCM bytes; all production spawn deadlines=${CODEC_TIMEOUT_MS}ms`
  );
});
