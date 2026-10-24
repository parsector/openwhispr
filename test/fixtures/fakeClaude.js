#!/usr/bin/env node
// Test-only stand-in for the CLI protocol. Never invokes Claude or its auth.
const { spawn } = require("node:child_process");
if (process.argv.includes("--version")) {
  process.stdout.write("fake-claude 1\n");
  process.exit(0);
}
if (process.argv.includes("auth")) {
  process.stdout.write('{"loggedIn":true}\n');
  process.exit(0);
}
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
output({ type: "system", subtype: "init", session_id: "fake-session", model: "sonnet" });
if (prompt.includes("hang")) {
  // A descendant proves process-group cancellation includes the tree.
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  setInterval(() => {}, 1000);
} else {
  setTimeout(
    () => {
      if (prompt.includes("fail")) process.stderr.write("CLI rejected the request\n");
      output({
        type: "result",
        result: "Fake answer",
        duration_ms: 10,
        total_cost_usd: 0.01,
        is_error: prompt.includes("fail"),
        session_id: "fake-session",
      });
      process.exit(prompt.includes("fail") ? 1 : 0);
    },
    prompt.includes("slow") ? 300 : 10
  );
}
