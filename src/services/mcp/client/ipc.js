const { NAME } = require("./configStore");
function registerMcpIpc(manager, { ipcMain, dialog } = require("electron")) {
  const calls = new Map();
  const approvedTools = new Set();
  const validName = (name) => {
    if (typeof name !== "string" || !NAME.test(name)) throw new Error("Invalid MCP name");
    return name;
  };
  ipcMain.handle("mcp-client-list", () => manager.sync());
  ipcMain.handle("mcp-client-tools", (_event, name) => manager.tools(validName(name)));
  const clearApprovals = (name) => {
    for (const key of approvedTools) if (key.startsWith(`${name}__`)) approvedTools.delete(key);
  };
  ipcMain.handle("mcp-client-upsert", (_event, name, server, options) => {
    clearApprovals(validName(name));
    return manager.upsert(name, server, options);
  });
  ipcMain.handle("mcp-client-enable", (_event, name, enabled) =>
    manager.setEnabled(validName(name), enabled)
  );
  ipcMain.handle("mcp-client-confirm", async (_event, name, details) => {
    validName(name);
    const server = manager.config().mcpServers[name];
    if (!server || server.type === "http") throw new Error("Invalid MCP command confirmation");
    const exact = { command: server.command, args: server.args || [], cwd: server.cwd || null };
    if (JSON.stringify(details) !== JSON.stringify(exact))
      throw new Error("MCP command confirmation mismatch");
    const answer = await dialog.showMessageBox({
      type: "warning",
      title: "Confirm MCP server command",
      message: `Run ${name} as a local MCP server?`,
      detail: JSON.stringify(exact, null, 2),
      buttons: ["Cancel", "Run server"],
      defaultId: 0,
      cancelId: 0,
    });
    return answer.response === 1 ? manager.confirm(name, exact) : manager.list();
  });
  ipcMain.handle("mcp-client-allow", async (_event, name, allowed) => {
    validName(name);
    if (typeof allowed !== "boolean" || !manager.config().mcpServers[name])
      throw new Error("Invalid MCP approval setting");
    if (allowed) {
      const answer = await dialog.showMessageBox({
        type: "warning",
        title: "Allow MCP tools without asking",
        message: `Allow all tools from ${name} to run without asking?`,
        buttons: ["Cancel", "Allow"],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response !== 1) return manager.list();
    }
    return manager.setAllow(name, allowed);
  });
  ipcMain.handle("mcp-client-remove", (_event, name) => {
    clearApprovals(validName(name));
    return manager.remove(name);
  });
  ipcMain.handle("mcp-client-recent", () => manager.recent());
  ipcMain.handle("mcp-client-call", async (event, name, tool, args, requestId) => {
    validName(name);
    validName(tool);
    if (
      typeof requestId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(requestId) ||
      !args ||
      typeof args !== "object" ||
      Array.isArray(args)
    )
      throw new Error("Invalid MCP call");
    const config = manager.config();
    if (!manager.isEnabled(config, name) || !manager.tools(name).some((item) => item.name === tool))
      throw new Error("MCP tool unavailable");
    const key = `${event.sender.id}:${requestId}`;
    if (calls.has(key)) throw new Error("Duplicate MCP call");
    const controller = new AbortController();
    calls.set(key, controller);
    try {
      const approvalKey = `${name}__${tool}:${JSON.stringify(config.mcpServers[name])}`;
      if (!manager.settings(config, name).allowWithoutAsking && !approvedTools.has(approvalKey)) {
        const answer = await dialog.showMessageBox({
          type: "question",
          title: "Approve MCP tool",
          message: `Allow ${name}__${tool} to run?`,
          detail: JSON.stringify(args, null, 2).slice(0, 4000),
          buttons: ["Cancel", "Allow"],
          defaultId: 0,
          cancelId: 0,
        });
        if (answer.response !== 1) throw new Error("MCP tool call cancelled by user");
        if (controller.signal.aborted) throw controller.signal.reason;
        approvedTools.add(approvalKey);
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      return await manager.call(name, tool, args, controller.signal);
    } finally {
      calls.delete(key);
    }
  });
  ipcMain.handle("mcp-client-cancel", (event, requestId) => {
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(requestId))
      throw new Error("Invalid MCP request");
    calls.get(`${event.sender.id}:${requestId}`)?.abort(new Error("MCP call cancelled"));
    return true;
  });
}
module.exports = { registerMcpIpc };
