const assert = require("node:assert/strict");
const { app } = require("electron");

if (!process.versions.electron) throw new Error("This check must run in Electron");

app
  .whenReady()
  .then(() => {
    const { createToolRegistry } = require("../src/helpers/routines/routineToolRegistry.js");
    const database = { db: { prepare: () => ({ all: () => [] }) } };
    const registry = createToolRegistry({
      database,
      allowedTools: ["search_notes", "get_note", "get_calendar_events"],
      finishRun() {},
    });
    assert.equal(typeof registry.assembly.getAll, "function");
    assert.deepEqual(
      registry
        .list()
        .map((tool) => tool.name)
        .sort(),
      ["search_notes", "get_note", "get_calendar_events", "finish_run"].sort()
    );
    console.log("Routine tool assembly resolves in Electron main process");
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
