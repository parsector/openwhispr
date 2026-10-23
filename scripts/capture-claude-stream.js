#!/usr/bin/env node
// Owner-only fixture capture on a Mac with Claude installed and signed in.
// Usage: node scripts/capture-claude-stream.js /absolute/path/to/fixture.jsonl
// This runs a real read-only Claude prompt and writes its stream verbatim.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ALLOWED_TOOLS } = require("../src/services/agents/claudeRunner");
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination))
  throw new Error("Provide an absolute fixture path");
const args = [
  "-p",
  "Describe this repository in one sentence.",
  "--output-format",
  "stream-json",
  "--verbose",
  "--permission-mode",
  "dontAsk",
  "--allowedTools",
  ALLOWED_TOOLS,
];
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
process.stderr.write(`claude ${args.map(quote).join(" ")} > ${quote(destination)}\n`);
const child = spawn("claude", args, { stdio: ["ignore", "pipe", "inherit"] });
child.stdout.pipe(fs.createWriteStream(destination, { mode: 0o600 }));
child.on("exit", (code) => {
  process.exitCode = code || 0;
});
