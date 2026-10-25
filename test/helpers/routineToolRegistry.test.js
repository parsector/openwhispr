const test = require("node:test");
const assert = require("node:assert/strict");
const { createToolRegistry: assembleTools } = require("../../src/services/tools/index.ts");
const {
  createToolRegistry: routineTools,
} = require("../../src/helpers/routines/routineToolRegistry");

test("routine tools are drawn from the same assembly and names as chat", () => {
  const settings = {
    isSignedIn: false,
    productHelpEnabled: false,
    calendarConnected: true,
    cloudBackupEnabled: false,
    webSearchEnabled: false,
    keepNotesUnchanged: true,
  };
  const chat = assembleTools(settings);
  const database = {
    db: { prepare: () => ({ all: () => [] }) },
    searchNotes: () => [],
    getNote: () => null,
    getCalendarEventsInRange: () => [],
  };
  const routine = routineTools({
    database,
    allowedTools: chat.getAll().map((tool) => tool.name),
    finishRun: () => {},
  });
  assert.deepEqual(
    routine.assembly
      .getAll()
      .map((tool) => tool.name)
      .sort(),
    chat
      .getAll()
      .map((tool) => tool.name)
      .sort()
  );
  for (const tool of routine.list().filter((item) => item.name !== "finish_run")) {
    assert.ok(routine.assembly.get(tool.name), `${tool.name} must come from assembly`);
    assert.ok(chat.get(tool.name), `${tool.name} must exist in chat for these settings`);
  }
  assert.deepEqual(
    routine
      .list()
      .map((tool) => tool.name)
      .sort(),
    ["get_calendar_events", "get_note", "search_notes", "finish_run"].sort()
  );
});
