process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (!request.id) continue;
    if (request.method === "tools/call" && request.params.name === "hang") continue;
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: {},
            serverInfo: { name: "fake", version: "1" },
          }
        : request.method === "tools/list"
          ? {
              tools: [
                { name: "echo", inputSchema: { type: "object" } },
                { name: "hang", inputSchema: { type: "object" } },
              ],
            }
          : request.params.name === "error"
            ? null
            : { content: [{ type: "text", text: JSON.stringify(request.params.arguments) }] };
    const response = {
      jsonrpc: "2.0",
      id: request.id,
      ...(result === null ? { error: { code: -1, message: "fake error" } } : { result }),
    };
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
});
