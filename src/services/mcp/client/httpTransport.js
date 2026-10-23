const http = require("node:http");
const https = require("node:https");
function createHttpTransport(config) {
  let sessionId;
  return {
    async send(message, signal) {
      const url = new URL(config.url);
      const driver = url.protocol === "https:" ? https : http;
      if (!["https:", "http:"].includes(url.protocol)) throw new Error("Invalid MCP URL");
      const body = JSON.stringify(message);
      return new Promise((resolve, reject) => {
        const req = driver.request(
          url,
          {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              ...(config.headers || {}),
              ...(sessionId ? { "mcp-session-id": sessionId } : {}),
              "content-length": Buffer.byteLength(body),
            },
            signal,
          },
          (res) => {
            if (res.headers["mcp-session-id"]) sessionId = res.headers["mcp-session-id"];
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (part) => {
              data += part;
              if (data.length > 4 * 1024 * 1024) req.destroy(new Error("MCP response too large"));
            });
            res.on("end", () => {
              if (res.statusCode < 200 || res.statusCode >= 300)
                return reject(new Error(`MCP HTTP ${res.statusCode}`));
              if (message.method?.startsWith("notifications/")) return resolve(null);
              try {
                const json = res.headers["content-type"]?.includes("text/event-stream")
                  ? data
                      .split(/\r?\n\r?\n/)
                      .flatMap((event) =>
                        event
                          .split(/\r?\n/)
                          .filter((line) => line.startsWith("data:"))
                          .map((line) => line.slice(5).trim())
                      )
                      .filter((line) => line && line !== "[DONE]")
                      .map(JSON.parse)
                      .find((item) => item.id === message.id)
                  : JSON.parse(data);
                if (!json) throw new Error("Missing MCP response");
                resolve(json);
              } catch (error) {
                reject(error);
              }
            });
          }
        );
        req.on("error", reject);
        req.end(body);
      });
    },
    stop() {},
  };
}
module.exports = { createHttpTransport };
