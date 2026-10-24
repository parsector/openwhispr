const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { redactOutput } = require("./redactOutput");
const { jobPayload } = require("./debugPayload");
const { safeModel } = require("./modelSafety");
const { validSessionId } = require("./sessionId");
const { attachedNotePrompt, appendResultToNote } = require("./noteContext");
const { createWorktreeService, location } = require("./worktree");
const debugLogger = require("../../helpers/debugLogger");

const EXPIRY_MS = 10 * 60 * 1000;
const STALL_MS = 20 * 60 * 1000;
function normalizeOrigin(origin) {
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) return null;
  const value = origin.conversationId;
  const raw = typeof value === "number" ? String(value) : value;
  if (
    (typeof value === "number" && (!Number.isFinite(value) || !Number.isInteger(value))) ||
    typeof raw !== "string" ||
    !/^[0-9]+$/.test(raw)
  )
    return null;
  const conversationId = raw.replace(/^0+/, "");
  if (!conversationId || conversationId.length > 20) return null;
  const safe = {
    conversationId,
    surface: ["chat", "assistant"].includes(origin.surface) ? origin.surface : "chat",
  };
  for (const field of ["messageId", "toolCallId"])
    if (typeof origin[field] === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(origin[field]))
      safe[field] = origin[field];
  return safe;
}
function existingDirectory(folder) {
  try {
    return typeof folder === "string" && fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}
function invalid(field) {
  const error = new Error(`invalid_${field} (${field})`);
  error.field = field;
  return error;
}
function logFailure(action, error, input) {
  const field = error.field || "request";
  const value = field === "task" ? "[redacted]" : input?.[field];
  const bounded =
    typeof value === "string" || typeof value === "number"
      ? redactOutput(String(value).slice(0, 128)).replace(/[\r\n]/g, " ")
      : "[unavailable]";
  debugLogger.error(`Agent job ${action} failed`, {
    field,
    value: bounded,
    reason: redactOutput(String(error.message)).slice(0, 128),
  });
  error.agentJobLogged = true;
}
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
      if (Object.hasOwn(job, "origin")) {
        let normalized = null;
        try {
          normalized = normalizeOrigin(job.origin);
        } catch {}
        if (normalized) job.origin = normalized;
        else {
          delete job.origin;
          job.originDropped = true;
          debugLogger.warn("Agent job origin dropped", {
            field: "origin.conversationId",
            value: "[invalid]",
          });
        }
      }
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
    broadcast("agent-job-updated", jobPayload(job));
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
          project.mode === job.mode &&
          Boolean(project.trustWorkspace) === Boolean(job.project.trustWorkspace)
      );
  async function prepare(input) {
    try {
      return await prepareJob(input);
    } catch (error) {
      logFailure("prepare", error, input);
      throw error;
    }
  }
  async function prepareJob({ project, task, harness, model, mode, origin, resumeJobId, contextNoteId }) {
    const parent = resumeJobId === undefined ? null : jobs.get(resumeJobId);
    if (resumeJobId !== undefined && (!parent || !["done", "failed"].includes(parent.status)))
      throw new Error("unknown_job");
    if (parent && !validSessionId(parent.sessionId)) throw new Error("no_session");
    if (
      parent &&
      !projectStore
        .read()
        .projects.some(
          (item) =>
            item.name === parent.project.name &&
            item.folder === parent.project.folder &&
            item.defaultHarness === parent.harness &&
            item.mode === parent.mode &&
            existingDirectory(item.folder)
        )
    )
      throw new Error("project_missing");
    if (
      parent?.mode === "write" &&
      (!parent.worktreePath || !existingDirectory(parent.worktreePath))
    )
      throw new Error("worktree_missing");
    if (
      parent &&
      ((project !== undefined && project !== parent.project.name) ||
        (harness !== undefined && harness !== parent.harness) ||
        (mode !== undefined && mode !== parent.mode))
    )
      throw new Error("project_missing");
    project = parent?.project.name ?? project;
    harness = parent?.harness ?? harness;
    mode = parent?.mode ?? mode;
    if (typeof project !== "string" || !project.trim()) throw invalid("project");
    if (typeof task !== "string" || !task.trim() || task.length > 100_000) throw invalid("task");
    if (contextNoteId !== undefined && (!Number.isSafeInteger(contextNoteId) || contextNoteId <= 0))
      throw invalid("contextNoteId");
    if (harness !== undefined && !["claude", "cursor-agent"].includes(harness))
      throw invalid("harness");
    if (model !== undefined && !safeModel(model)) throw invalid("model");
    let safeOrigin = null;
    if (origin !== undefined) {
      try {
        safeOrigin = normalizeOrigin(origin);
      } catch {
        // Origin is advisory; even a malformed object must not block the job.
      }
    }
    if (origin !== undefined && !safeOrigin)
      debugLogger.warn("Agent job origin dropped", {
        field: "origin.conversationId",
        value: "[invalid]",
      });
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
    let contextNote = null;
    if (contextNoteId !== undefined) {
      contextNote = databaseManager.getNote(contextNoteId);
      if (contextNote?.deleted_at) contextNote = null;
      if (!contextNote) debugLogger.warn("Agent job context dropped", {
        field: "contextNoteId", value: contextNoteId, reason: "note_missing",
      });
    }
    const context = contextNote
      ? attachedNotePrompt(task.trim(), contextNote.title, [contextNote.content, contextNote.enhanced_content].filter(Boolean).join("\n\n"))
      : null;
    const job = {
      jobId: crypto.randomUUID(),
      project: {
        name: selected.name,
        folder: selected.folder,
        trustWorkspace: selected.trustWorkspace === true,
      },
      harness: selectedHarness,
      mode: selectedMode,
      model: model?.trim() || parent?.model || selected.model || null,
      prompt: context?.prompt ?? task.trim(),
      ...(contextNote ? { contextNoteId, contextNoteTitle: contextNote.title, contextChars: context.contextChars } : {}),
      ...(contextNoteId !== undefined && !contextNote ? { contextDropped: true, contextDropReason: "note_missing" } : {}),
      ...(safeOrigin ? { origin: safeOrigin } : {}),
      ...(origin !== undefined && !safeOrigin ? { originDropped: true } : {}),
      status: "pending",
      steps: [],
      result: null,
      reason: null,
      lastError: null,
      costEstimate: null,
      sessionId: null,
      ...(parent ? { resumedFrom: parent.jobId, resumeSessionId: parent.sessionId } : {}),
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
      Object.assign(
        job,
        parent
          ? { branch: parent.branch, worktreePath: parent.worktreePath, worktreeCreated: true }
          : {
              ...location(path.dirname(path.dirname(file)), selected.name, job.jobId),
              worktreeCreated: false,
            }
      );
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
      contextNoteId: job.contextNoteId,
      contextNoteTitle: job.contextNoteTitle,
      contextChars: job.contextChars,
      contextDropped: job.contextDropped,
      contextDropReason: job.contextDropReason,
    };
  }
  async function launch(job) {
    try {
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
      if (job.mode === "write" && !job.resumedFrom) {
        preparingWorktrees.add(job.jobId);
        try {
          await worktreeService.create(job);
          job.worktreeCreated = true;
          update(job);
        } catch (error) {
          debugLogger.error("Agent job start failed", {
            field: "worktree",
            value: "[unavailable]",
            reason: redactOutput(error.message).slice(0, 128),
          });
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
      if (job.resumedFrom && job.mode === "write" && !existingDirectory(job.worktreePath)) {
        fail(job, "worktree_missing");
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
        ...(job.resumeSessionId ? { resumeSessionId: job.resumeSessionId } : {}),
        ...(job.mode === "write" ? { mode: "write", branch: job.branch } : {}),
        ...(job.harness === "cursor-agent" ? { mode: job.mode } : {}),
        ...(job.harness === "cursor-agent" ? { trustWorkspace: job.project.trustWorkspace } : {}),
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
        if (outcome.reason === "workspace_untrusted") {
          job.lastError =
            redactOutput(outcome.trustRefusalLine || lastError(outcome.stderr) || "")
              .trim()
              .slice(0, 500) || null;
          fail(job, "workspace_untrusted");
        } else if (collectionError) {
          fail(job, "worktree_failed");
        } else if (outcome.exitCode === 0 && outcome.resultEvent && !outcome.resultEvent.is_error) {
          try {
            job.noteId = saveResult(job);
            job.status = "done";
            job.endedAt = now();
            job.finishedAt = job.endedAt;
            update(job);
          } catch (error) {
            debugLogger.error("Agent job completion failed", {
              field: "note",
              value: "[unavailable]",
              reason: redactOutput(error.message).slice(0, 128),
            });
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
      debugLogger.error("Agent job start failed", {
        field: "start",
        value: "[unavailable]",
        reason: redactOutput(error.message).slice(0, 128),
      });
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
  function saveResult(job) {
    if (job.contextNoteId) {
      const note = databaseManager.getNote(job.contextNoteId);
      const space = note && databaseManager.getSpace?.(note.space_id);
      const writable = note && !note.deleted_at &&
        (!note.cloud_id || note.owner_user_id === databaseManager.activeAccountId ||
          space?.kind === "team") &&
        (!space || space.kind !== "team" || !space.cloud_space_id ||
          ["member", "admin"].includes(space.my_role));
      if (writable) {
        try {
          const saved = appendResultToNote(databaseManager, note, job, now());
          if (saved?.success) {
            if (!saved.alreadyAppended) broadcast("note-updated", saved.note);
            return note.id;
          }
        } catch (error) {
          debugLogger.warn("Agent job context append unavailable", {
            field: "contextNoteId", value: job.contextNoteId,
            reason: redactOutput(error.message).slice(0, 128),
          });
        }
      }
      job.contextAppendFallback = true;
    }
    return saveNote(job);
  }
  function drain() {
    while (activeCount() < 2 && queue.length) {
      const id = queue.shift();
      queuePositions();
      void launch(jobs.get(id));
    }
  }
  async function approve(jobId, input = {}) {
    try {
      return await approveJob(jobId, input);
    } catch (error) {
      logFailure("approve", error, input);
      throw error;
    }
  }
  async function approveJob(jobId, { prompt, contextNoteId } = {}) {
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
    if (contextNoteId !== undefined) {
      if (!Number.isSafeInteger(contextNoteId) || contextNoteId <= 0) throw invalid("contextNoteId");
      const note = databaseManager.getNote(contextNoteId);
      if (note && !note.deleted_at) {
        const context = attachedNotePrompt(job.prompt, note.title, [note.content, note.enhanced_content].filter(Boolean).join("\n\n"));
        job.prompt = context.prompt;
        job.contextNoteId = contextNoteId;
        job.contextNoteTitle = note.title;
        job.contextChars = context.contextChars;
        delete job.contextDropped;
        delete job.contextDropReason;
      } else {
        job.contextDropped = true;
        job.contextDropReason = "note_missing";
        debugLogger.warn("Agent job context dropped", {
          field: "contextNoteId", value: contextNoteId, reason: "note_missing",
        });
      }
    }
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
    if (
      [...jobs.values()].some(
        (other) =>
          other.jobId !== jobId &&
          other.worktreePath === job.worktreePath &&
          ["pending", "queued", "running"].includes(other.status)
      )
    )
      throw new Error("Worktree is used by another job");
    await worktreeService.discard(job);
    job.discardedAt = now();
    return update(job);
  }
  return { prepare, approve, cancel, discard, get, list, stopAll, checkStalls };
}
module.exports = { createJobManager, EXPIRY_MS, STALL_MS };
