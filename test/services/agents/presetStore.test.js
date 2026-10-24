const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createProjectStore } = require("../../../src/services/agents/projectStore");
const {
  createPresetStore,
  extractPlaceholders,
  resolvePresetPrompt,
} = require("../../../src/services/agents/presetStore");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-presets-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projectStore = createProjectStore(path.join(dir, "agents", "projects.json"));
  projectStore.save({
    name: "repo",
    folder: dir,
    defaultHarness: "claude",
    mode: "read-only",
    model: "sonnet",
  });
  const file = path.join(dir, "agents", "presets.json");
  const store = createPresetStore(file, projectStore);
  const preset = {
    id: "p1",
    name: "Review PR",
    project: "repo",
    harness: "claude",
    model: "sonnet",
    mode: "read-only",
    prompt: "Review {{pr}}",
    description: "Review a PR",
  };
  return { dir, file, projectStore, store, preset };
}

test("extracts placeholders and rejects unclosed, malformed, and duplicate placeholders", () => {
  assert.deepEqual(extractPlaceholders("Review {{pr}} and {{file}}"), ["pr", "file"]);
  assert.deepEqual(extractPlaceholders("Inspect {literal} with {{file}}"), ["file"]);
  for (const prompt of [
    "Review {{pr",
    "Review pr}}",
    "{{pr}} {{pr}}",
    "{{bad-name}}",
    "{{}}",
    "{{{pr}}}",
  ])
    assert.throws(() => extractPlaceholders(prompt));
  assert.equal(resolvePresetPrompt("Review {{pr}}", { pr: " 42 " }), "Review 42");
  assert.throws(() => resolvePresetPrompt("Review {{pr}}", {}), /Missing value/);
  assert.throws(() => resolvePresetPrompt("Review {{pr}}", { pr: "42", path: "/tmp" }), /Invalid/);
});

test("validates every field against the project allowlist and disallows mode smuggling", (t) => {
  const { store, preset } = setup(t);
  store.save(preset);
  assert.equal(store.read().presets[0].name, "Review PR");
  assert.equal(
    store.save({ ...preset, model: " provider/model:v2 " }).presets[0].model,
    "provider/model:v2"
  );
  store.save({ ...preset, name: "プルリクエストをレビュー" });
  assert.equal(store.read().presets[0].name, "プルリクエストをレビュー");
  for (const bad of [
    { project: "missing" },
    { harness: "cursor-agent" },
    { mode: "write" },
    { mode: "agent" },
    { model: "--danger" },
    { promptPath: "/tmp/prompt" },
    { prompt: "Review {{pr" },
  ])
    assert.throws(() => store.save({ ...preset, ...bad }));
  assert.throws(
    () => store.write({ presets: [preset, { ...preset, id: "p2", name: "review pr" }] }),
    /Duplicate/
  );
  assert.equal(store.read().presets.length, 1);
});

test("fan-out requires the known enumerator and a pr placeholder", (t) => {
  const { store, preset } = setup(t);
  assert.equal(
    store.save({ ...preset, fanOut: "open-pull-requests" }).presets[0].fanOut,
    "open-pull-requests"
  );
  assert.throws(() => store.save({ ...preset, fanOut: "issues" }), /fanOut/);
  assert.throws(
    () => store.save({ ...preset, prompt: "Review this", fanOut: "open-pull-requests" }),
    /fanOut/
  );
  assert.equal(store.save(preset).presets[0].fanOut, undefined);
});

test("schedule bounds, static prompt and read-only mode are validated and run times persist", (t) => {
  const { file, store, preset, projectStore } = setup(t);
  const plain = { ...preset, prompt: "Review the repository" };
  for (const intervalMinutes of [0, 14, 10081, 1.5, NaN, "60", null])
    assert.throws(
      () => store.save({ ...plain, schedule: { intervalMinutes, enabled: true } }),
      /schedule/
    );
  for (const schedule of [
    null,
    [],
    { intervalMinutes: 60 },
    { intervalMinutes: 60, enabled: "yes" },
    { intervalMinutes: 60, enabled: true, junk: 1 },
  ])
    assert.throws(() => store.save({ ...plain, schedule }), /schedule/);
  assert.throws(
    () => store.save({ ...preset, schedule: { intervalMinutes: 15, enabled: true } }),
    /schedule_requires_static_prompt/
  );
  const first = store.save({ ...plain, schedule: { intervalMinutes: 15, enabled: true } })
    .presets[0];
  assert.ok(first.nextRunAt > Date.now());
  assert.equal(first.lastRunAt, null);
  assert.equal(store.recordRun("p1", 1000), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).presets[0].schedule, {
    intervalMinutes: 15,
    enabled: true,
  });
  assert.equal(store.read().presets[0].lastRunAt, 1000);
  assert.equal(store.read().presets[0].nextRunAt, 901000);
  assert.equal(
    store.save({
      ...plain,
      schedule: { intervalMinutes: 15, enabled: true },
      lastRunAt: 9999,
      nextRunAt: 9999,
    }).presets[0].nextRunAt,
    901000
  );
  projectStore.remove("repo");
  assert.equal(store.read().presets[0].id, "p1");
  projectStore.save({
    name: "repo",
    folder: path.dirname(file),
    defaultHarness: "claude",
    mode: "read-only",
    model: "sonnet",
  });
  projectStore.save({
    name: "writer",
    folder: path.dirname(file),
    defaultHarness: "claude",
    mode: "write",
    model: null,
  });
  assert.throws(
    () =>
      store.save({
        ...plain,
        id: "w",
        name: "Writer",
        project: "writer",
        mode: "write",
        schedule: { intervalMinutes: 15, enabled: true },
      }),
    /schedule_requires_read_only/
  );
});

test("writes atomically, cleans a failed temp write, and recovers a malformed file", (t) => {
  const { file, store, preset, projectStore } = setup(t);
  store.save(preset);
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((name) => name.includes("preset")),
    ["presets.json"]
  );
  const original = fs.readFileSync(file, "utf8");
  const failingFs = {
    ...fs,
    renameSync: () => {
      throw new Error("rename failed");
    },
  };
  const failingStore = createPresetStore(file, projectStore, failingFs);
  assert.throws(() => failingStore.save({ ...preset, description: "changed" }), /rename failed/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp")),
    []
  );
  fs.writeFileSync(file, "broken");
  assert.deepEqual(store.read(), { presets: [] });
  assert.ok(
    fs.readdirSync(path.dirname(file)).some((name) => name.startsWith("presets.json.corrupt."))
  );
});
