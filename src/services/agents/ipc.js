const { harnessPayload, jobPayload } = require("./debugPayload");
const { openTerminal } = require("./openTerminal");
const { redactOutput } = require("./redactOutput");
const debugLogger = require("../../helpers/debugLogger");

function logFailure(action, error, input) {
  const field = error.field || "request";
  const value =
    field === "task" ? "[redacted]" : input && typeof input === "object" ? input[field] : undefined;
  const bounded =
    typeof value === "string" || typeof value === "number"
      ? redactOutput(String(value).slice(0, 128)).replace(/[\r\n]/g, " ")
      : "[unavailable]";
  debugLogger.error(`Agent job ${action} failed`, {
    field,
    value: bounded,
    reason: redactOutput(String(error.message)).slice(0, 128),
  });
}

function invalid(field) {
  const error = new Error(`invalid_${field} (${field})`);
  error.field = field;
  return error;
}

function registerAgentIpc({
  ipcMain,
  projectStore,
  presetStore,
  resolver,
  manager,
  openTerminalImpl = openTerminal,
}) {
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const exact = (value, keys) =>
    object(value) && Object.keys(value).every((key) => keys.includes(key));
  const name = (value) => {
    if (typeof value !== "string" || !/^[a-zA-Z0-9 _.-]{1,80}$/.test(value))
      throw new Error("Invalid name");
    return value;
  };
  ipcMain.handle("agent-projects-list", () => projectStore.read());
  ipcMain.handle("agent-projects-save", (_event, project) => projectStore.save(project));
  ipcMain.handle("agent-projects-remove", (_event, projectName) =>
    projectStore.remove(name(projectName))
  );
  ipcMain.handle("agent-presets-list", () => presetStore.read());
  ipcMain.handle("agent-presets-save", (_event, preset) => presetStore.save(preset));
  ipcMain.handle("agent-presets-remove", (_event, id) => presetStore.remove(name(id)));
  ipcMain.handle("agent-projects-test-harness", async (_event, harness) => {
    if (!["claude", "cursor-agent"].includes(harness)) throw new Error("Invalid harness");
    const result = await resolver.test(harness);
    const auth = await resolver.authStatus(harness);
    return harnessPayload(result, auth);
  });
  ipcMain.handle("agent-projects-list-models", () => resolver.listModels("cursor-agent"));
  ipcMain.handle("agent-job-prepare", async (_event, input) => {
    try {
      if (!object(input)) throw invalid("request");
      if (!exact(input, ["project", "task", "harness", "model", "mode", "origin", "resumeJobId", "contextNoteId"]))
        throw invalid("request");
      return jobPayload(await manager.prepare(input));
    } catch (error) {
      if (!error.agentJobLogged) logFailure("prepare", error, input);
      throw error;
    }
  });
  ipcMain.handle("agent-job-approve", async (_event, id, input = {}) => {
    try {
      if (!exact(input, ["prompt", "contextNoteId"])) throw invalid("prompt");
      return jobPayload(await manager.approve(id, input));
    } catch (error) {
      if (!error.agentJobLogged) logFailure("approve", error, input);
      throw error;
    }
  });
  ipcMain.handle("agent-job-cancel", (_event, id) => jobPayload(manager.cancel(name(id))));
  ipcMain.handle("agent-job-discard", async (_event, id) =>
    jobPayload(await manager.discard(name(id)))
  );
  ipcMain.handle("agent-job-open-terminal", async (_event, input) => {
    if (!exact(input, ["jobId"]) || Object.keys(input).length !== 1) throw invalid("request");
    const job = manager.get(name(input.jobId));
    if (!job) throw new Error("unknown_job");
    await openTerminalImpl(job);
    return { ok: true };
  });
  ipcMain.handle("agent-job-list", () => manager.list().map(jobPayload));
  ipcMain.handle("agent-job-get", (_event, id) => jobPayload(manager.get(name(id))));
}
module.exports = { registerAgentIpc };
