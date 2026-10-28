const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("meeting finalize schedules extraction after returning from the IPC listener", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");
  const start = source.indexOf('ipcMain.on("meeting-note-finalized"');
  const end = source.indexOf('ipcMain.handle("commitments-list"', start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  assert.match(handler, /setImmediate\(\(\) => \{/);
  assert.match(handler, /extractCommitments\(/);
  assert.doesNotMatch(handler, /await\s+extractCommitments\(/);
  assert.match(handler, /\.catch\(\(error\) => debugLogger\.error/);
});
