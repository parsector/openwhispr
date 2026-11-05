// Run the current regression against the four implementation files at the
// starting commit, without modifying this checkout or touching live state.
const Module = require("node:module");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const original = Module._extensions[".js"];
const files = new Set([
  "meetingAudioStore.js",
  "voiceEnrollment.js",
  "voiceEnrollmentRecovery.js",
  "voiceRecordingIdentity.js",
]);
Module._extensions[".js"] = (module, filename) => {
  if (path.dirname(filename) === path.resolve("src/helpers") && files.has(path.basename(filename)))
    module._compile(
      execFileSync("git", ["show", `97a89a768:src/helpers/${path.basename(filename)}`], {
        encoding: "utf8",
      }),
      filename
    );
  else original(module, filename);
};
