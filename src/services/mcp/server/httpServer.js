const http = require("node:http");
const crypto = require("node:crypto");

const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED = new Set([PROTOCOL_VERSION, "2025-03-26"]);
const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_PORT = 51874;

function createMcpHttpServer({ tokens, tools, port = DEFAULT_PORT }) {
  const sessions = new Map();
  let server;
  let starting;
  const json = (response, status, body, headers = {}) => {
    response.writeHead(status, { "Content-Type": "application/json", ...headers });
    response.end(JSON.stringify(body));
  };
  const error = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  async function handle(request, response) {
    const host = request.headers.host;
    if (!host || host !== `127.0.0.1:${server.address().port}` || request.url !== "/mcp") {
      json(response, 403, { error: "Forbidden" }); return;
    }
    const bearer = /^Bearer (owk_[A-Za-z0-9_-]{43})$/.exec(request.headers.authorization || "");
    const token = bearer && tokens.verify(bearer[1]);
    if (!token) {
      json(response, 401, { error: "Unauthorized" }, { "WWW-Authenticate": "Bearer" }); return;
    }
    if (request.method === "DELETE") {
      const session = sessions.get(request.headers["mcp-session-id"]);
      if (!session || session.tokenId !== token.id) { json(response, 404, { error: "Session not found" }); return; }
      sessions.delete(request.headers["mcp-session-id"]);
      response.writeHead(204); response.end(); return;
    }
    if (request.method !== "POST") { json(response, 405, { error: "Method not allowed" }); return; }
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      json(response, 415, { error: "Expected application/json" }); return;
    }
    const accept = request.headers.accept || "application/json";
    if (!accept.includes("application/json") && !accept.includes("text/event-stream") && !accept.includes("*/*")) {
      json(response, 406, { error: "Unsupported Accept header" }); return;
    }
    let body = "";
    try {
      body = await new Promise((resolve, reject) => {
        const chunks = []; let size = 0;
        request.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error("Body too large"), { status: 413 })); request.pause(); }
          else chunks.push(chunk);
        });
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        request.on("error", reject);
      });
    } catch (cause) { if (!response.writableEnded) json(response, cause.status || 400, { error: cause.message }); return; }
    if (response.writableEnded) return;
    let message;
    try { message = JSON.parse(body); }
    catch { json(response, 400, error(null, -32700, "Parse error")); return; }
    if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      json(response, 400, error(message?.id ?? null, -32600, "Invalid Request")); return;
    }
    const { id, method, params = {} } = message;
    let sessionId = request.headers["mcp-session-id"];
    let session;
    let result;
    try {
      if (method === "initialize") {
        if (sessionId) { json(response, 400, error(id ?? null, -32600, "Unexpected session")); return; }
        const version = SUPPORTED.has(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSION;
        sessionId = crypto.randomUUID();
        session = { tokenId: token.id, clientName: params.clientInfo?.name || "Unknown client", initialized: false, version };
        sessions.set(sessionId, session);
        result = { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "openwhispr-local", version: "1.0.0" } };
      } else {
        session = sessions.get(sessionId);
        if (!session || session.tokenId !== token.id) { json(response, 404, { error: "Session not found" }); return; }
        if (request.headers["mcp-protocol-version"] && request.headers["mcp-protocol-version"] !== session.version) {
          json(response, 400, error(id ?? null, -32600, "Protocol version mismatch")); return;
        }
        if (method === "notifications/initialized") {
          session.initialized = true;
          response.writeHead(202); response.end(); return;
        }
        if (!session.initialized) { json(response, 400, error(id ?? null, -32600, "Session not initialized")); return; }
        if (method === "ping") result = {};
        else if (method === "tools/list") result = { tools: tools.definitions };
        else if (method === "tools/call") {
          if (!tools.definitions.some((tool) => tool.name === params.name)) throw Object.assign(new Error("Unknown tool"), { code: -32602 });
          result = await tools.call(params.name, params.arguments);
          tokens.record(session.clientName, params.name);
        } else throw Object.assign(new Error("Method not found"), { code: -32601 });
      }
    } catch (cause) { result = undefined; message = error(id ?? null, cause.code || -32603, cause.message || "Internal error"); }
    if (id === undefined) { response.writeHead(202); response.end(); return; }
    const payload = result === undefined ? message : { jsonrpc: "2.0", id, result };
    const headers = { "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": session.version };
    if (accept.includes("text/event-stream") && !accept.includes("application/json")) {
      response.writeHead(200, { ...headers, "Content-Type": "text/event-stream" });
      response.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    } else json(response, 200, payload, headers);
  }
  function start() {
    if (starting) return starting;
    if (server) return Promise.resolve(`http://127.0.0.1:${server.address().port}/mcp`);
    server = http.createServer((request, response) => {
      const deadline = setTimeout(() => { if (!response.writableEnded) json(response, 504, { error: "Request timed out" }); }, REQUEST_TIMEOUT_MS);
      response.on("close", () => clearTimeout(deadline));
      handle(request, response).catch(() => { if (!response.writableEnded) json(response, 500, { error: "Internal error" }); });
    });
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    starting = new Promise((resolve, reject) => {
      function listen(candidatePort) {
        const onError = (cause) => {
          if (cause.code === "EADDRINUSE" && candidatePort !== 0) {
            listen(0);
          } else {
            server = null;
            starting = null;
            reject(cause);
          }
        };
        server.once("error", onError);
        server.listen(candidatePort, "127.0.0.1", () => {
          server.removeListener("error", onError);
          starting = null;
          resolve(`http://127.0.0.1:${server.address().port}/mcp`);
        });
      }
      listen(port);
    });
    return starting;
  }
  function stop() { sessions.clear(); if (server) { server.closeAllConnections(); server.close(); server = null; } }
  return { start, stop };
}

module.exports = { createMcpHttpServer, PROTOCOL_VERSION, MAX_BODY_BYTES, DEFAULT_PORT };
