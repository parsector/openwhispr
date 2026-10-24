const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { redactOutput } = require("./redactOutput");
const { safeModel } = require("./modelSafety");
const { createWorktreeService, location } = require("./worktree");

const EXPIRY_MS = 10 * 60 * 1000;
const STALL_MS = 20 * 60 * 1000;
function createJobManager({
  file,
  projectStore,
  resolver,
  runnerFactory,
  runnerFactories,
  databaseManager,
  broadcast = () => {},
  policyAllowed = async () => true,
  now = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  pidFile = null,
  worktreeService = null,
}) {
  pidFile ||= require("../../helpers/sidecarPidFile");
  worktreeService ||= createWorktreeService({ userData: path.dirname(path.dirname(file)) });
  const jobs = new Map();
  const running = new Map();
  const preparingWorktrees = new Set();
  let queue = [];
  function persist() {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
    const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify({ jobs: [...jobs.values()] }, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(temp, file);
      if (process.platform !== "win32") fs.chmodSync(file, 0o600);
    } catch (error) {
      try {
        fs.unlinkSync(temp);
      } catch {}
      throw error;
    }
  }
  try {
    for (const job of JSON.parse(fs.readFileSync(file, "utf8")).jobs || []) {
      if (!job.mode && job.harness === "claude") job.mode = "read-only";
      if (["running", "queued"].includes(job.status)) {
        job.status = "failed";
        job.reason = "interrupted";
        job.endedAt = now();
        job.finishedAt = job.endedAt;
      }
      jobs.set(job.jobId, job);
    }
    persist();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  void worktreeService
    .sweep([...jobs.values()], now())
    .then(persist)
    .catch((error) => console.warn("Agent worktree sweep failed", redactOutput(error.message)));
  function update(job) {
    persist();
    broadcast("agent-job-updated", { ...job });
    return { ...job };
  }
  function get(jobId) {
    return jobs.has(jobId) ? { ...jobs.get(jobId) } : null;
  }
  function list() {
    return [...jobs.values()].map((job) => ({ ...job }));
  }
  function queuePositions() {
    queue.forEach((id, index) => {
      const job = jobs.get(id);
      if (job.position !== index + 1) {
        job.position = index + 1;
        update(job);
      }
    });
  }
  function checkStalls() {
    for (const job of jobs.values())
      if (job.status === "running" && !job.stalled && now() - job.lastEventAt >= STALL_MS) {
        job.stalled = true;
        update(job);
      }
  }
  const timer = setIntervalImpl(checkStalls, 60_000);
  timer.unref?.();
  function fail(job, reason) {
    job.status = "failed";
    job.reason = reason;
    job.endedAt = now();
    job.finishedAt = job.endedAt;
    update(job);
  }
  function lastError(stderr) {
    const lines = redactOutput(stderr)
      .split(/\r?\n/)
      .map((line) => line.trim());
    return lines.filter(Boolean).at(-1)?.slice(0, 500) || null;
  }
  const activeCount = () => [...jobs.values()].filter((job) => job.status === "running").length;
  const projectStillAllowed = (job) =>
    projectStore
      .read()
      .projects.some(
        (project) =>
          project.name === job.project.name &&
          project.folder === job.project.folder &&
          project.defaultHarness === job.harness &&
          project.mode === job.mode
      );
  async function prepare({ project, task, harness, model, mode }) {
    if (
      typeof project !== "string" ||
      typeof task !== "string" ||
      !task.trim() ||
      task.length > 100_000 ||
      (harness !== undefined && !["claude", "cursor-agent"].includes(harness)) ||
      (model !== undefined && !safeModel(model))
    )
      throw new Error("Invalid job request");
    if (!(await policyAllowed())) throw new Error("agent_disallowed");
    const selected = projectStore.read().projects.find((item) => item.name === project);
    if (!selected) throw new Error("Unknown project");
    const selectedHarness = harness || selected.defaultHarness;
    if (mode === "agent") throw new Error("Cursor agent mode requires --force and is unavailable");
    if (selectedHarness !== selected.defaultHarness)
      throw new Error("Harness does not match project");
    if (selectedHarness === "cursor-agent" && task.trimStart().startsWith("-"))
      throw new Error("Invalid Cursor prompt");
    const selectedMode = mode || selected.mode;
    if (
      selectedMode !== selected.mode ||
      (selectedHarness === "claude"
        ? !["read-only", "write"].includes(selectedMode)
        : !["plan", "ask"].includes(selectedMode))
    )
      throw new Error("Mode does not match project");
    const auth = await resolver.authStatus(selectedHarness).catch(() => ({ state: "unknown" }));
    const resolved = await resolver.resolve(selectedHarness);
    if (!resolved.ok) throw new Error(resolved.error);
    const job = {
      jobId: crypto.randomUUID(),
      project: { name: selected.name, folder: selected.folder },
      harness: selectedHarness,
      mode: selectedMode,
      model: model?.trim() || selected.model || null,
      prompt: task.trim(),
      status: "pending",
      steps: [],
      result: null,
      reason: null,
      lastError: null,
      costEstimate: null,
      sessionId: null,
      createdAt: now(),
      expiresAt: now() + EXPIRY_MS,
      startedAt: null,
      endedAt: null,
      finishedAt: null,
      lastEventAt: null,
      stalled: false,
      authWarning: auth.state !== "authenticated",
      position: null,
    };
    if (selectedMode === "write")
      Object.assign(job, location(path.dirname(path.dirname(file)), selected.name, job.jobId), {
        worktreeCreated: false,
      });
    jobs.set(job.jobId, job);
    update(job);
    return {
      jobId: job.jobId,
      project: job.project,
      harness: job.harness,
      mode: job.mode,
      model: job.model,
      prompt: job.prompt,
      authWarning: job.authWarning,
      branch: job.branch,
    };
  }
  async function launch(job) {
    job.status = "running";
    job.position = null;
    job.startedAt = now();
    job.lastEventAt = now();
    update(job);
    if (!(await policyAllowed()) || !projectStillAllowed(job)) {
      if (job.status === "running") fail(job, "agent_disallowed");
      drain();
      return;
    }
    const resolved = await resolver.resolve(job.harness);
    if (job.status === "cancelled") {
      drain();
      return;
    }
    if (!resolved.ok) {
      fail(job, resolved.error);
      drain();
      return;
    }
    try {
      if (job.mode === "write") {
        preparingWorktrees.add(job.jobId);
        try {
          await worktreeService.create(job);
          job.worktreeCreated = true;
          update(job);
        } catch (error) {
          job.worktreeCreated = fs.existsSync(job.worktreePath);
          job.lastError = redactOutput(error.message).trim().slice(0, 500);
          fail(job, "worktree_failed");
          drain();
          return;
        } finally {
          preparingWorktrees.delete(job.jobId);
        }
      }
      if (job.status === "cancelled") {
        drain();
        return;
      }
      const makeRunner =
        runnerFactories?.[job.harness] || (job.harness === "claude" ? runnerFactory : null);
      if (!makeRunner) throw new Error("Harness unavailable");
      const runner = makeRunner(resolved.path).start({
        folder: job.mode === "write" ? job.worktreePath : job.project.folder,
        prompt: job.prompt,
        model: job.model,
        ...(job.mode === "write" ? { mode: "write", branch: job.branch } : {}),
        ...(job.harness === "cursor-agent" ? { mode: job.mode } : {}),
        onEvent(event) {
          if (job.status !== "running") return;
          job.lastEventAt = now();
          job.stalled = false;
          job.steps.push(event);
          if (job.steps.length > 200) job.steps.shift();
          if (event.kind === "init") job.sessionId = event.session_id;
          if (event.kind === "result") {
            job.result = event.answer;
            job.costEstimate = event.total_cost_usd;
            job.sessionId = event.session_id || job.sessionId;
            job.durationMs = event.duration_ms;
            job.resultError = event.is_error;
          }
          update(job);
        },
      });
      running.set(job.jobId, runner);
      pidFile.write(`agent-job-${job.jobId}`, runner.pid);
      update(job);
      runner.done.then(async (outcome) => {
        running.delete(job.jobId);
        pidFile.clear(`agent-job-${job.jobId}`);
        let collectionError = null;
        if (job.mode === "write" && job.worktreePath) {
          try {
            Object.assign(job, await worktreeService.collect(job));
          } catch (error) {
            collectionError = error;
            job.lastError = redactOutput(error.message).trim().slice(0, 500);
          }
        }
        if (job.status === "cancelled") {
          job.endedAt = now();
          job.finishedAt = job.endedAt;
          update(job);
          drain();
          return;
        }
        if (collectionError) {
          fail(job, "worktree_failed");
        } else if (outcome.exitCode === 0 && outcome.resultEvent && !outcome.resultEvent.is_error) {
          try {
            job.noteId = saveNote(job);
            job.status = "done";
            job.endedAt = now();
            job.finishedAt = job.endedAt;
            update(job);
          } catch (error) {
            fail(job, error.message);
          }
        } else {
          job.lastError = lastError(outcome.stderr);
          fail(
            job,
            outcome.error ||
              (outcome.resultEvent?.is_error
                ? "result_error"
                : `exit_${outcome.exitCode ?? outcome.signal ?? "unknown"}`)
          );
        }
        drain();
      });
    } catch (error) {
      fail(job, error.message);
      drain();
    }
  }
  function saveNote(job) {
    const privateSpaceId = databaseManager.getPrivateSpaceId();
    if (privateSpaceId == null) throw new Error("Private space unavailable");
    let folderId = databaseManager
      .getFolders(privateSpaceId)
      .find((folder) => folder.name === "Agent jobs")?.id;
    if (!folderId) {
      const created = databaseManager.createFolder("Agent jobs", privateSpaceId);
      if (!created.success) throw new Error(created.error);
      folderId = created.folder.id;
    }
    const content = [
      job.result || "",
      ...(job.mode === "write"
        ? [
            "Changes",
            `Branch: ${job.branch}`,
            `Worktree path: ${job.worktreePath}`,
            job.diffStat || "(no tracked changes)",
          ]
        : []),
      `Project: ${job.project.name}`,
      `Duration: ${job.durationMs ?? "unknown"} ms`,
      `Cost estimate: ${job.costEstimate ?? "unknown"} USD`,
      `Session ID: ${job.sessionId || "unknown"}`,
      ...job.steps.filter((step) => step.kind === "tool").map((step) => step.summary),
    ].join("\n\n");
    const saved = databaseManager.saveNote(
      `Agent job: ${job.project.name}`,
      content,
      "personal",
      null,
      null,
      folderId,
      privateSpaceId
    );
    if (!saved?.success) throw new Error(saved?.error || "Could not save note");
    broadcast("note-added", saved.note);
    return saved.note.id;
  }
  function drain() {
    while (activeCount() < 2 && queue.length) {
      const id = queue.shift();
      queuePositions();
      void launch(jobs.get(id));
    }
  }
  async function approve(jobId, { prompt } = {}) {
    if (
      typeof jobId !== "string" ||
      (prompt !== undefined &&
        (typeof prompt !== "string" || !prompt.trim() || prompt.length > 100_000))
    )
      throw new Error("Invalid approval");
    if (!(await policyAllowed())) throw new Error("agent_disallowed");
    const job = jobs.get(jobId);
    if (!job || job.status !== "pending") throw new Error("Job not pending");
    if (!projectStillAllowed(job)) throw new Error("Project no longer allowed");
    if (now() >= job.expiresAt) {
      fail(job, "expired");
      throw new Error("expired");
    }
    if (job.harness === "cursor-agent" && prompt?.trimStart().startsWith("-"))
      throw new Error("Invalid Cursor prompt");
    if (prompt !== undefined) job.prompt = prompt.trim();
    if (activeCount() >= 2 || queue.length) {
      job.status = "queued";
      queue.push(jobId);
      queuePositions();
      return update(job);
    }
    await launch(job);
    return get(jobId);
  }
  function cancel(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw new Error("Unknown job");
    if (!["pending", "queued", "running"].includes(job.status)) return get(jobId);
    if (job.status === "queued") {
      queue = queue.filter((id) => id !== jobId);
      queuePositions();
    }
    if (job.status === "running") running.get(jobId)?.cancel();
    job.status = "cancelled";
    job.endedAt = now();
    job.finishedAt = job.endedAt;
    update(job);
    return get(jobId);
  }
  function stopAll() {
    for (const id of [...running.keys()]) cancel(id);
    clearIntervalImpl(timer);
  }
  async function discard(jobId) {
    const job = jobs.get(jobId);
    if (!job || job.mode !== "write") throw new Error("Unknown write job");
    if (
      ["pending", "queued", "running"].includes(job.status) ||
      running.has(jobId) ||
      preparingWorktrees.has(jobId)
    )
      throw new Error("Job is still running");
    if (job.discardedAt) return get(jobId);
    await worktreeService.discard(job);
    job.discardedAt = now();
    return update(job);
  }
  return { prepare, approve, cancel, discard, get, list, stopAll, checkStalls };
}
module.exports = { createJobManager, EXPIRY_MS, STALL_MS };
