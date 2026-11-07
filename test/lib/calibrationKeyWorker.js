// Real calibration worker with an empty credential store, independent of the
// host's Keychain. All SQLite, audio decryption and evidence code remains real.
const Module = require("node:module");
const load = Module._load;
// Accelerate only the new key-wait deadline in its regression. Production must
// still request exactly 60 seconds; embedding/decoder timers are untouched.
if (require("node:worker_threads").workerData.keyRecoveryTimeoutTest) {
  const timeout = global.setTimeout;
  global.setTimeout = (callback, ms, ...args) => timeout(callback, ms === 60000 ? 30 : ms, ...args);
}
Module._load = function (request, ...args) {
  if (request === "@napi-rs/keyring")
    return {
      Entry: class {
        getPassword() {
          return null;
        }
        setPassword() {
          throw new Error("Calibration must never write a recording key");
        }
      },
    };
  return load.call(this, request, ...args);
};
require("../../src/workers/calibrationWorker");
