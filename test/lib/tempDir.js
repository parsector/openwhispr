const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Accept a basename in OS temp, a prefix relative to an explicit parent, or an
// absolute prefix when a fixture needs to preserve its existing location.
function createTempDir(prefix, parent = os.tmpdir()) {
  const resolvedPrefix = path.resolve(parent, prefix);
  fs.mkdirSync(path.dirname(resolvedPrefix), { recursive: true });
  return fs.mkdtempSync(resolvedPrefix);
}

module.exports = createTempDir;
