// Direct main-process MCP access bypasses the renderer IPC approval dialog.
// The routine tool wrapper checks current permissions before every call.
function routineMcpApi(manager) {
  const calls = new Map();
  return {
    list: async () => manager.list(),
    tools: async (name) => manager.tools(name),
    call: async (name, tool, args, requestId) => {
      const server = manager.list().servers.find((item) => item.name === name);
      const current = manager.tools(name).find((item) => item.name === tool);
      if (
        !server?.enabled ||
        server.status !== "connected" ||
        !current ||
        !(current.annotations?.readOnlyHint === true || server.allowWithoutAsking)
      )
        throw new Error("needs approval");
      const controller = new AbortController();
      calls.set(requestId, controller);
      try {
        return await manager.call(name, tool, args, controller.signal);
      } finally {
        calls.delete(requestId);
      }
    },
    cancel: async (requestId) => {
      calls.get(requestId)?.abort();
    },
  };
}

module.exports = { routineMcpApi };
