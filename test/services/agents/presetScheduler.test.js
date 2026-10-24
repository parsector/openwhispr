const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const { createPresetScheduler } = require("../../../src/services/agents/presetScheduler");

function setup(overrides = {}) {
  let time = 1_000_000;
  let timer;
  let cleared = false;
  const warnings = [];
  const started = [];
  const preset = {
    id: "daily",
    name: "Daily",
    project: "repo",
    harness: "claude",
    mode: "read-only",
    prompt: "Review repository",
    schedule: { intervalMinutes: 15, enabled: true },
    nextRunAt: time - 500_000,
    lastRunAt: null,
  };
  const project = { name: "repo", folder: os.tmpdir(), mode: "read-only" };
  const jobs = [];
  let authenticated = true;
  const scheduler = createPresetScheduler({
    presetStore: {
      read: () => ({ presets: [preset] }),
      recordRun: (_id, at) => {
        preset.lastRunAt = at;
        preset.nextRunAt = at + preset.schedule.intervalMinutes * 60_000;
      },
    },
    projectStore: { read: () => ({ projects: project ? [project] : [] }) },
    manager: {
      list: () => jobs,
      startScheduled: async (item) => {
        started.push(item.id);
      },
    },
    resolver: {
      authStatus: async () => ({ state: authenticated ? "authenticated" : "not_authenticated" }),
    },
    now: () => time,
    setIntervalImpl: (callback) => {
      timer = callback;
      return { unref() {} };
    },
    clearIntervalImpl: () => {
      cleared = true;
    },
    logger: { warn: (_message, detail) => warnings.push(detail.reason) },
    ...overrides,
  });
  return {
    scheduler,
    preset,
    project,
    jobs,
    started,
    warnings,
    advance: (ms) => {
      time += ms;
    },
    setAuthenticated: (value) => {
      authenticated = value;
    },
    timer: () => timer,
    cleared: () => cleared,
    now: () => time,
  };
}

test("due launch and long-gap catch-up run once and advance from now", async () => {
  const ctx = setup();
  await ctx.scheduler.tick();
  assert.deepEqual(ctx.started, ["daily"]);
  assert.equal(ctx.preset.lastRunAt, ctx.now());
  assert.equal(ctx.preset.nextRunAt, ctx.now() + 900_000);
  await ctx.scheduler.tick();
  assert.equal(ctx.started.length, 1);
  ctx.advance(30 * 900_000);
  await ctx.scheduler.tick();
  assert.deepEqual(ctx.started, ["daily", "daily"]);
  assert.equal(ctx.preset.nextRunAt, ctx.now() + 900_000);
});

test("running or queued job, missing project, write project and sign-out skip without advancing", async () => {
  const ctx = setup();
  const due = ctx.preset.nextRunAt;
  for (const status of ["running", "queued"]) {
    ctx.jobs.splice(0, ctx.jobs.length, { scheduledFrom: "daily", status });
    await ctx.scheduler.tick();
    assert.equal(ctx.preset.nextRunAt, due);
  }
  ctx.jobs.length = 0;
  ctx.project.name = "missing";
  await ctx.scheduler.tick();
  assert.equal(ctx.preset.nextRunAt, due);
  ctx.project.name = "repo";
  ctx.project.mode = "write";
  await ctx.scheduler.tick();
  assert.equal(ctx.preset.nextRunAt, due);
  ctx.project.mode = "read-only";
  ctx.setAuthenticated(false);
  await ctx.scheduler.tick();
  assert.equal(ctx.preset.nextRunAt, due);
  assert.deepEqual(ctx.started, []);
  assert.deepEqual(ctx.warnings, [
    "schedule_already_running",
    "schedule_already_running",
    "project_missing",
    "schedule_requires_read_only",
    "not_authenticated",
  ]);
  ctx.setAuthenticated(true);
  await ctx.scheduler.tick();
  assert.deepEqual(ctx.started, ["daily"]);
});

test("stop clears the timer and prevents later ticks", async () => {
  const ctx = setup();
  ctx.scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ctx.started, ["daily"]);
  ctx.scheduler.stop();
  assert.equal(ctx.cleared(), true);
  ctx.advance(900_000);
  ctx.timer()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ctx.started, ["daily"]);
});
