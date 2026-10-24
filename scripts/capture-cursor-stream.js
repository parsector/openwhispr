#!/usr/bin/env node
// Owner-only fixture capture on a Mac with Cursor installed and signed in.
// Usage: node scripts/capture-cursor-stream.js /absolute/path/to/fixture.jsonl
// Captures a real non-interactive Cursor plan stream for parser fixtures.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination))
  throw new Error("Provide an absolute fixture path");
const args = [
  "-p",
  "--output-format",
  "stream-json",
  "--stream-partial-output",
  "--mode",
  "plan",
  "Describe this repository in one sentence.",
];
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
process.stderr.write(`cursor-agent ${args.map(quote).join(" ")} > ${quote(destination)}\n`);
const child = spawn("cursor-agent", args, { stdio: ["ignore", "pipe", "inherit"] });
child.stdout.pipe(fs.createWriteStream(destination, { mode: 0o600 }));
child.on("exit", (code) => {
  process.exitCode = code || 0;
});
