const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

test("routine assembly is current and loads without the tsx test hook", () => {
  const check = spawnSync(process.execPath, ["scripts/build-routine-tool-assembly.js", "--check"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  assert.equal(check.status, 0, check.stderr);

  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      `const assert = require('node:assert/strict');
       const {createToolRegistry} = require('./src/helpers/routines/routineToolRegistry.js');
       const registry = createToolRegistry({
         database: {db: {prepare: () => ({all: () => []})}},
         allowedTools: ['search_notes', 'get_note', 'get_calendar_events'],
         finishRun() {},
       });
       assert.equal(typeof registry.assembly.getAll, 'function');
       assert.deepEqual(registry.list().map(tool => tool.name).sort(),
         ['search_notes', 'get_note', 'get_calendar_events', 'finish_run'].sort());`,
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } }
  );
  assert.equal(probe.status, 0, probe.stderr);
});
