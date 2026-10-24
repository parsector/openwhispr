const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { redactOutput } = require("./redactOutput");

const run = promisify(execFile);
const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
function location(userData, project, jobId) {
  const projectSlug = slug(project);
  const shortId = slug(jobId.slice(0, 8));
  return {
    branch: `agent/${projectSlug}-${shortId}`,
    worktreePath: path.join(userData, "agents", "worktrees", projectSlug, jobId),
  };
}
function createWorktreeService({ userData, runGit = run, logger = console } = {}) {
  const git = (cwd, args) => runGit("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  async function create(job) {
    const { branch, worktreePath } = location(userData, job.project.name, job.jobId);
    job.branch = branch;
    job.worktreePath = worktreePath;
    try {
      const relative = path.relative(job.project.folder, worktreePath);
      if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
        throw new Error("Worktree path must be outside the project folder");
      const root = (await git(job.project.folder, ["rev-parse", "--show-toplevel"])).stdout.trim();
      if (path.resolve(root) !== path.resolve(job.project.folder)) throw new Error("Project folder is not the git checkout root");
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true, mode: 0o700 });
      await git(job.project.folder, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
      const dependencies = path.join(job.project.folder, "node_modules");
      if (fs.existsSync(dependencies)) fs.symlinkSync(dependencies, path.join(worktreePath, "node_modules"), "dir");
      return { branch, worktreePath };
    } catch (error) {
      const detail = redactOutput([error.stderr, error.stdout, error.message].filter(Boolean).join("\n"));
      const failure = new Error(detail);
      failure.reason = "worktree_failed";
      throw failure;
    }
  }
  async function collect(job) {
    const [diff, status] = await Promise.all([
      git(job.worktreePath, ["diff", "--stat"]),
      git(job.worktreePath, ["status", "--porcelain"]),
    ]);
    return { diffStat: diff.stdout.trimEnd(), changedFileCount: status.stdout.split(/\r?\n/).filter(Boolean).length };
  }
  async function discard(job) {
    await git(job.project.folder, ["worktree", "remove", "--force", job.worktreePath]);
    await git(job.project.folder, ["branch", "-D", job.branch]);
  }
  async function sweep(jobs, now = Date.now()) {
    for (const job of jobs) {
      if (job.mode !== "write" || !job.worktreePath || job.discardedAt ||
          !(job.finishedAt ?? job.endedAt) || now - (job.finishedAt ?? job.endedAt) <= 7 * 24 * 60 * 60 * 1000 ||
          ["pending", "queued", "running"].includes(job.status)) continue;
      try { await discard(job); job.discardedAt = now; }
      catch (error) { logger.warn("Agent worktree sweep failed", redactOutput(error.message)); }
    }
  }
  return { create, collect, discard, sweep };
}
module.exports = { createWorktreeService, location };
