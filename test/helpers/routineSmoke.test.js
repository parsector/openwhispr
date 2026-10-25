const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

test("saving the gallery template and running it writes a note and done row", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-routine-smoke-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron")
      return {
        app: { getPath: () => directory, getAppPath: () => process.cwd(), isReady: () => false },
      };
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => {
    Module._load = originalLoad;
  });
  process.env.NODE_ENV = "test";
  const DatabaseManager = require("../../src/helpers/database.js");
  let database;
  try {
    database = new DatabaseManager();
  } catch (error) {
    if (/NODE_MODULE_VERSION|Could not locate the bindings file/.test(String(error))) {
      t.skip("better-sqlite3 binding unavailable");
      return;
    }
    throw error;
  }
  t.after(() => database.db.close());
  const preset = require("../../src/helpers/routines/routinePresets").PRESETS[0];
  let saved;
  try {
    saved = database.saveRoutine({
      name: "Morning brief",
      prompt: preset.prompt,
      trigger_config: preset.trigger_config,
      allowed_tools: preset.suggested_tools,
    });
  } catch (error) {
    throw new Error(`saveRoutine: ${error.message}`, { cause: error });
  }
  assert.equal(saved.success, true, saved.error);
  const routine = saved.routine;
  const folder = database.getFolders().find((item) => item.routine_id === routine.id);
  assert.ok(folder);
  const { RoutineRunner } = require("../../src/helpers/routines/routineRunner");
  const runner = new RoutineRunner({
    database,
    infer: async ({ registry, context }) => {
      assert.ok(registry.get("get_calendar_events"));
      await registry.get("finish_run").execute({ empty: false, headline: "Ready" }, context);
      return { text: "## Morning brief\n- [ ] Follow up tomorrow", toolsAvailable: true };
    },
  });
  const { RoutineQueue } = require("../../src/helpers/routines/routineQueue");
  const { RoutineScheduler } = require("../../src/helpers/routines/routineScheduler");
  const queue = new RoutineQueue({ run: (job) => runner.run(job) });
  const scheduler = new RoutineScheduler({
    database,
    queue,
    modelChoice: () => ({ mode: "local", provider: "local", model: "test-4b" }),
  });
  const result = await scheduler.runNow(routine.id);
  assert.equal(result.status, "done", result.error);
  assert.equal(result.note.folder_id, folder.id);
  const run = database.getRoutineRuns(routine.id)[0];
  assert.equal(run.status, "done");
  assert.equal(run.slot_key, `manual:${run.id}`);
  assert.equal(database.routineUnreadCount(), 1);
  database.markRoutineNoteSeen(result.note.id);
  assert.equal(database.routineUnreadCount(), 0);
  const collision = database.saveRoutine({
    name: "Personal",
    prompt: preset.prompt,
    trigger_config: preset.trigger_config,
  });
  assert.equal(collision.success, false);
  assert.equal(database.listRoutines().length, 1);
  database.db.prepare("UPDATE notes SET folder_id=NULL WHERE id=?").run(result.note.id);
  assert.equal(
    require("../../src/helpers/routines/routineRunner").actionItemContext(database, Date.now())
      .matched,
    0
  );
});
