const { harnessPayload, jobPayload } = require("./debugPayload");

function registerAgentIpc({ ipcMain, projectStore, presetStore, resolver, manager }) {
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
  ipcMain.handle("agent-job-prepare", (_event, input) => {
    if (!exact(input, ["project", "task", "harness", "model", "mode"]))
      throw new Error("Invalid job request");
    return Promise.resolve(manager.prepare(input)).then(jobPayload);
  });
  ipcMain.handle("agent-job-approve", (_event, id, input = {}) => {
    if (!exact(input, ["prompt"])) throw new Error("Invalid approval");
    return Promise.resolve(manager.approve(id, input)).then(jobPayload);
  });
  ipcMain.handle("agent-job-cancel", (_event, id) => jobPayload(manager.cancel(name(id))));
  ipcMain.handle("agent-job-discard", async (_event, id) =>
    jobPayload(await manager.discard(name(id)))
  );
  ipcMain.handle("agent-job-list", () => manager.list().map(jobPayload));
  ipcMain.handle("agent-job-get", (_event, id) => jobPayload(manager.get(name(id))));
}
module.exports = { registerAgentIpc };
