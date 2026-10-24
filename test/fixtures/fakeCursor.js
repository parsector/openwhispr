#!/usr/bin/env node
// Test-only Cursor stream; never invokes the real CLI.
const { spawn } = require("node:child_process");
if (process.argv.includes("--version")) {
  process.stdout.write("fake-cursor 1\n");
  process.exit(0);
}
if (process.argv.includes("status")) {
  process.stdout.write("Login successful\n");
  process.exit(0);
}
const prompt = process.argv.at(-1);
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
output({ type: "system", subtype: "init", session_id: "cursor-session", model: "auto" });
if (prompt.includes("hang")) {
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  setInterval(() => {}, 1000);
} else
  setTimeout(
    () => {
      if (prompt.includes("fail")) process.stderr.write("Bearer secret sk-secret owk_secret\n");
      output({
        type: "result",
        result: "Cursor answer",
        duration_ms: 10,
        is_error: prompt.includes("fail"),
        session_id: "cursor-session",
      });
      process.exit(prompt.includes("fail") ? 1 : 0);
    },
    prompt.includes("slow") ? 300 : 10
  );
