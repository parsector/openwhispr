const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createWorktreeService, location } = require("../../../src/services/agents/worktree");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-worktree-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const userData = path.join(root, "userData");
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "source.txt"), "before\n");
  git(repo, "add", "source.txt");
  git(repo, "commit", "-qm", "initial");
  return {
    root,
    repo,
    userData,
    service: createWorktreeService({ userData }),
    job: { jobId: "abcdef12-1234", project: { name: "My Project", folder: repo }, mode: "write" },
  };
}
test("creates branch from HEAD outside checkout, links dependencies, collects diff and discards", async (t) => {
  const { repo, service, job } = fixture(t);
  fs.mkdirSync(path.join(repo, "node_modules"));
  fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
  const head = git(repo, "rev-parse", "HEAD").trim();
  const { branch, worktreePath } = await service.create(job);
  assert.deepEqual(
    { branch, worktreePath },
    location(
      path.dirname(path.dirname(path.dirname(path.dirname(worktreePath)))),
      job.project.name,
      job.jobId
    )
  );
  assert.ok(!worktreePath.startsWith(repo + path.sep));
  assert.equal(git(worktreePath, "rev-parse", "HEAD").trim(), head);
  assert.equal(git(worktreePath, "branch", "--show-current").trim(), branch);
  assert.equal(fs.lstatSync(path.join(worktreePath, "node_modules")).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(worktreePath, ".env")), false);
  fs.writeFileSync(path.join(worktreePath, "source.txt"), "after\n");
  const result = await service.collect(job);
  assert.match(result.diffStat, /source.txt/);
  assert.equal(result.changedFileCount, 2); // source and linked node_modules
  assert.equal(git(repo, "status", "--porcelain").trim(), "?? .env");
  await service.discard(job);
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(git(repo, "branch", "--list", branch).trim(), "");
});
test("sweep removes old completed worktree and preserves running worktree", async (t) => {
  const { repo, service, job } = fixture(t);
  await service.create(job);
  const running = { ...job, jobId: "12345678-running" };
  await service.create(running);
  const now = Date.now();
  await service.sweep(
    [
      { ...job, status: "done", finishedAt: now - 8 * 86400000 },
      { ...running, status: "running", finishedAt: now - 8 * 86400000 },
    ],
    now
  );
  assert.equal(fs.existsSync(job.worktreePath), false);
  assert.equal(fs.existsSync(running.worktreePath), true);
  assert.equal(git(repo, "branch", "--list", job.branch).trim(), "");
});
test("non git project reports worktree_failed", async (t) => {
  const { root, service, job } = fixture(t);
  job.project.folder = path.join(root, "plain");
  fs.mkdirSync(job.project.folder);
  await assert.rejects(
    service.create(job),
    (error) => error.reason === "worktree_failed" && /not a git repository/.test(error.message)
  );
});

test("sweep keeps a shared worktree until the most recent resumed job ages out", async (t) => {
  const { service, job } = fixture(t);
  await service.create(job);
  const now = Date.now();
  const parent = { ...job, status: "done", finishedAt: now - 8 * 86400000 };
  const resumed = {
    ...job,
    jobId: "resumed",
    resumedFrom: job.jobId,
    status: "done",
    finishedAt: now - 86400000,
  };
  await service.sweep([parent, resumed], now);
  assert.equal(fs.existsSync(job.worktreePath), true);
  await service.sweep([parent, resumed], now + 8 * 86400000);
  assert.equal(fs.existsSync(job.worktreePath), false);
  assert.equal(typeof parent.discardedAt, "number");
  assert.equal(parent.discardedAt, resumed.discardedAt);
});
