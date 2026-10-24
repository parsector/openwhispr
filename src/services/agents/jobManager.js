const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { redactOutput } = require("./redactOutput");

const EXPIRY_MS = 10 * 60 * 1000;
const STALL_MS = 20 * 60 * 1000;
function createJobManager({
  file,
  projectStore,
  resolver,
  runnerFactory,
  databaseManager,
  broadcast = () => {},
  policyAllowed = async () => true,
  now = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  pidFile = null,
}) {
  pidFile ||= require("../../helpers/sidecarPidFile");
  const jobs = new Map();
  const running = new Map();
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
      if (["running", "queued"].includes(job.status)) {
        job.status = "failed";
        job.reason = "interrupted";
        job.endedAt = now();
      }
      jobs.set(job.jobId, job);
    }
    persist();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
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
          project.mode === "read-only"
      );
  async function prepare({ project, task, harness, model }) {
    if (
      typeof project !== "string" ||
      typeof task !== "string" ||
      !task.trim() ||
      task.length > 100_000 ||
      (harness !== undefined && harness !== "claude") ||
      (model !== undefined &&
        (typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(model)))
    )
      throw new Error("Invalid job request");
    if (!(await policyAllowed())) throw new Error("agent_disallowed");
    const selected = projectStore.read().projects.find((item) => item.name === project);
    if (!selected) throw new Error("Unknown project");
    const selectedHarness = harness || selected.defaultHarness;
    if (selectedHarness !== "claude") throw new Error("Harness unavailable in slice A");
    if ((await resolver.authStatus("claude")).state !== "authenticated")
      throw new Error("not_authenticated");
    const resolved = await resolver.resolve("claude");
    if (!resolved.ok) throw new Error(resolved.error);
    const job = {
      jobId: crypto.randomUUID(),
      project: { name: selected.name, folder: selected.folder },
      harness: selectedHarness,
      model: model || selected.model || null,
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
      lastEventAt: null,
      stalled: false,
      position: null,
    };
    jobs.set(job.jobId, job);
    update(job);
    return {
      jobId: job.jobId,
      project: job.project,
      harness: job.harness,
      model: job.model,
      prompt: job.prompt,
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
    if ((await resolver.authStatus("claude")).state !== "authenticated") {
      if (job.status === "running") fail(job, "not_authenticated");
      drain();
      return;
    }
    const resolved = await resolver.resolve("claude");
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
      const runner = runnerFactory(resolved.path).start({
        folder: job.project.folder,
        prompt: job.prompt,
        model: job.model,
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
      runner.done.then((outcome) => {
        running.delete(job.jobId);
        pidFile.clear(`agent-job-${job.jobId}`);
        if (job.status === "cancelled") {
          job.endedAt = now();
          update(job);
          drain();
          return;
        }
        if (outcome.exitCode === 0 && outcome.resultEvent && !outcome.resultEvent.is_error) {
          try {
            job.noteId = saveNote(job);
            job.status = "done";
            job.endedAt = now();
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
    update(job);
    return get(jobId);
  }
  function stopAll() {
    for (const id of [...running.keys()]) cancel(id);
    clearIntervalImpl(timer);
  }
  return { prepare, approve, cancel, get, list, stopAll, checkStalls };
}
module.exports = { createJobManager, EXPIRY_MS, STALL_MS };
