const fs = require("node:fs");
const path = require("node:path");

const MAX_BYTES = 1024 * 1024;
const BACKUPS = 2;

function getLogPath(userData) {
  return path.join(userData, "logs", "updater.log");
}

function sanitize(value) {
  return String(value)
    .replace(/(authorization\s*[:=]\s*(?:Basic|Bearer)\s+)\S+/gi, "$1<redacted>")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (match) => {
      try {
        const url = new URL(match);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "<URL>";
      }
    })
    .replace(/(authorization|token|password|secret)\s*[:=]\s*\S+/gi, "$1=<redacted>");
}

function createUpdaterLog(userData) {
  const file = getLogPath(userData);
  function write(level, value) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const line = `${new Date().toISOString()} ${level} ${sanitize(value)}\n`;
      const bytes = Buffer.byteLength(line);
      const current = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (current + bytes > MAX_BYTES) {
        for (let i = BACKUPS; i >= 1; i--) {
          const source = i === 1 ? file : `${file}.${i - 1}`;
          const destination = `${file}.${i}`;
          if (fs.existsSync(source)) fs.renameSync(source, destination);
        }
      }
      fs.appendFileSync(file, Buffer.from(line).subarray(0, MAX_BYTES), { mode: 0o600 });
    } catch (error) {
      console.warn("Could not write updater log:", error.message);
    }
  }
  const logger = {
    info: (value) => write("INFO", value),
    warn: (value) => write("WARN", value),
    error: (value) => write("ERROR", value),
    debug: (value) => write("DEBUG", value),
  };
  return { file, write, logger };
}

module.exports = { createUpdaterLog, getLogPath };
