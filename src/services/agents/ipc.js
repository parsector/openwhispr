function registerAgentIpc({ ipcMain, projectStore, resolver, manager }) {
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
  ipcMain.handle("agent-projects-test-harness", async (_event, harness) => {
    if (!["claude", "cursor-agent"].includes(harness)) throw new Error("Invalid harness");
    const result = await resolver.test(harness);
    return { ...result, auth: await resolver.authStatus(harness) };
  });
  ipcMain.handle("agent-job-prepare", (_event, input) => {
    if (!exact(input, ["project", "task", "harness", "model"]))
      throw new Error("Invalid job request");
    return manager.prepare(input);
  });
  ipcMain.handle("agent-job-approve", (_event, id, input = {}) => {
    if (!exact(input, ["prompt"])) throw new Error("Invalid approval");
    return manager.approve(id, input);
  });
  ipcMain.handle("agent-job-cancel", (_event, id) => manager.cancel(name(id)));
  ipcMain.handle("agent-job-list", () => manager.list());
  ipcMain.handle("agent-job-get", (_event, id) => manager.get(name(id)));
}
module.exports = { registerAgentIpc };
