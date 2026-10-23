const { createStdioTransport } = require("./stdioTransport");
const { createHttpTransport } = require("./httpTransport");
const TIMEOUT_MS = 30000;
class McpClient {
  constructor(config, options = {}) {
    this.onFailure = options.onFailure;
    this.closed = false;
    this.transport =
      config.type === "http"
        ? createHttpTransport(config)
        : createStdioTransport(config, options.onSpawn);
    this.pending = new Map();
    this.controllers = new Set();
    this.nextId = 1;
    this.transport.onMessage?.((message) => this.receive(message));
    this.transport.onError?.((error) => this.fail(error));
  }
  receive(message) {
    const pending = this.pending.get(message.id);
    if (pending) pending.resolve(message);
  }
  fail(error) {
    if (!this.closed) this.onFailure?.(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  async request(method, params = {}, signal, timeoutMs = TIMEOUT_MS) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    const controller = new AbortController();
    this.controllers.add(controller);
    const onAbort = () => controller.abort(signal?.reason || new Error("MCP call cancelled"));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("MCP call timed out")), timeoutMs);
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      let response;
      if (this.transport.onMessage) {
        response = await new Promise((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
            once: true,
          });
          try {
            this.transport.send(message);
          } catch (error) {
            reject(error);
          }
        });
      } else response = await this.transport.send(message, controller.signal);
      if (response?.id !== id || response?.jsonrpc !== "2.0")
        throw new Error("Invalid MCP response");
      if (response.error) throw new Error(response.error.message || "MCP request failed");
      return response.result;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      this.pending.delete(id);
      this.controllers.delete(controller);
    }
  }
  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "OpenWhispr", version: "1.0" },
    });
    const notice = { jsonrpc: "2.0", method: "notifications/initialized" };
    if (this.transport.onMessage) this.transport.send(notice);
    else await this.transport.send(notice);
    const result = await this.request("tools/list");
    if (!Array.isArray(result?.tools)) throw new Error("Invalid tools/list response");
    this.tools = result.tools;
    return this.tools;
  }
  call(name, args, signal) {
    return this.request("tools/call", { name, arguments: args }, signal);
  }
  stop() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort(new Error("MCP server stopped"));
    this.fail(new Error("MCP server stopped"));
    this.transport.stop();
  }
}
module.exports = { McpClient, TIMEOUT_MS };
