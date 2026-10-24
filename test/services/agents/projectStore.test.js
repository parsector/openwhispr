const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createProjectStore } = require("../../../src/services/agents/projectStore");
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-projects-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    file: path.join(dir, "agents", "projects.json"),
    project: {
      name: "openwhispr",
      folder: dir,
      defaultHarness: "claude",
      mode: "read-only",
      model: "sonnet",
    },
  };
}
test("validates project allowlist and rejects extra fields", (t) => {
  const { file, project } = setup(t);
  const store = createProjectStore(file);
  assert.throws(() => store.save({ ...project, command: "evil" }));
  assert.throws(() => store.save({ ...project, folder: "relative" }));
  store.save(project);
  assert.equal(store.read().projects[0].name, "openwhispr");
});
test("atomic write and uniqueness", (t) => {
  const { file, project } = setup(t);
  const store = createProjectStore(file);
  store.write({ projects: [project] });
  assert.equal(fs.readdirSync(path.dirname(file)).length, 1);
  assert.throws(
    () => store.write({ projects: [project, { ...project, name: "OpenWhispr" }] }),
    /Duplicate/
  );
});
test("recovers malformed file", (t) => {
  const { file } = setup(t);
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, "{");
  assert.deepEqual(createProjectStore(file).read(), { projects: [] });
  assert.ok(fs.readdirSync(path.dirname(file)).some((name) => name.includes("corrupt")));
});

test("project mode is fixed for Claude and limited to Cursor plan or ask", (t) => {
  const { file, project } = setup(t);
  const store = createProjectStore(file);
  assert.throws(() => store.save({ ...project, mode: "plan" }), /Invalid project mode/);
  assert.equal(store.save({ ...project, mode: "write" }).projects[0].mode, "write");
  assert.throws(
    () => store.save({ ...project, defaultHarness: "cursor-agent", mode: "write" }),
    /requires Claude/
  );
  for (const mode of ["plan", "ask"])
    assert.equal(
      store.save({ ...project, defaultHarness: "cursor-agent", mode }).projects[0].mode,
      mode
    );
  assert.throws(
    () => store.save({ ...project, defaultHarness: "cursor-agent", mode: "agent" }),
    /requires --force/
  );
});

test("safe model strings save unchanged except surrounding whitespace", (t) => {
  const { file, project } = setup(t);
  const store = createProjectStore(file);
  for (const model of ["grok-4.7", "provider/model:v2", "model with spaces", "x.y-z_1"]) {
    assert.equal(store.save({ ...project, model }).projects[0].model, model);
  }
  assert.equal(store.save({ ...project, model: "  grok-4.7  " }).projects[0].model, "grok-4.7");
  for (const model of [
    "-flag",
    "foo\nbar",
    "foo\tbar",
    "foo;bar",
    "foo$(bar)",
    'foo"bar',
    "foo'bar",
    "foo%bar",
    "x".repeat(81),
  ])
    assert.throws(() => store.save({ ...project, model }), /Invalid model/);
});

test("workspace trust defaults off and persists only for Cursor", (t) => {
  const { file, project } = setup(t);
  const store = createProjectStore(file);
  assert.equal(store.save(project).projects[0].trustWorkspace, false);
  assert.throws(
    () => store.save({ ...project, trustWorkspace: true }),
    /only available for Cursor/
  );
  const cursor = { ...project, defaultHarness: "cursor-agent", mode: "plan", trustWorkspace: true };
  assert.equal(store.save(cursor).projects[0].trustWorkspace, true);
  assert.equal(createProjectStore(file).read().projects[0].trustWorkspace, true);
});
