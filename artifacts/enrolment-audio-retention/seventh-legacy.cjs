// Isolated historical runtime for the seventh-run upgrade regression. Never
// changes the checkout or opens application data; callers supply test fixtures.
const Module = require("node:module");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const cache = new Map();
function historical(name) {
  if (cache.has(name)) return cache.get(name).exports;
  const filename = path.resolve("src/helpers", `${name}.js`);
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  cache.set(name, module);
  const load = module.require.bind(module);
  module.require = (request) =>
    request === "./voiceRecordingIdentity" ? historical("voiceRecordingIdentity") : load(request);
  module._compile(
    execFileSync("git", ["show", `0e5965045:src/helpers/${name}.js`], { encoding: "utf8" }),
    filename
  );
  return module.exports;
}
module.exports = historical;
