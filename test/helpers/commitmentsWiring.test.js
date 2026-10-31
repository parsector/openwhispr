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
  assert.match(handler, /\.catch\(\(error\) =>\s*debugLogger\.error\(/);
});

test("note scoped lookup and Todos navigation use narrow IPC channels", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "../../preload.js"), "utf8");
  assert.match(source, /ipcMain\.handle\("commitments-for-note"[\s\S]*?commitments\(\)\.forNote\(noteId\)/);
  assert.match(source, /ipcMain\.handle\("commitments-open-todos"[\s\S]*?sendToControlPanel\("todos-navigation-pending"\)/);
  assert.match(source, /ipcMain\.handle\("commitments-pending-todos-filter"/);
  assert.match(preload, /commitmentsForNote:.*"commitments-for-note"/);
  assert.match(preload, /onTodosNavigationPending:.*"todos-navigation-pending"/);
});
