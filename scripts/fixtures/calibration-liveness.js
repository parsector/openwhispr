#!/usr/bin/env node
const { fixture, measure } = require("../../test/lib/calibrationLivenessFixture");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, fork } = require("node:child_process");

// Pin every source dependency, not just the entry function. Extraction is
// isolated under ignored node_modules/.cache; it never changes the checkout.
function baselineRoot() {
  const root = path.resolve("node_modules/.cache/calibration-baseline-d50e80bc0");
  if (!fs.existsSync(path.join(root, "package.json"))) {
    fs.mkdirSync(root, { recursive: true });
    const archive = execFileSync("git", ["archive", "d50e80bc0", "src", "package.json"], {
      maxBuffer: 128 * 1024 * 1024,
    });
    execFileSync("tar", ["-x", "-C", root], { input: archive });
  }
  return root;
}

function watchdog(count) {
  const child = fork(__filename, [String(count), "--baseline", "--child"], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  let started,
    deadline,
    ticks = 0,
    processedRows = 0;
  child.on("message", (message) => {
    if (message.type === "ready") {
      started = performance.now();
      setTimeout(() => child.send("cancel"), 5);
      deadline = setTimeout(
        () => {
          const status = fs.readFileSync(`/proc/${child.pid}/status`, "utf8");
          console.log(
            JSON.stringify({
              count,
              censored: true,
              wallMs: +(performance.now() - started).toFixed(1),
              longestStallAtLeastMs: +(performance.now() - started - 5).toFixed(1),
              ticks,
              processedRows,
              cancelLatencyAtLeastMs: +(performance.now() - started - 5).toFixed(1),
              peakRssMiB: +(Number(status.match(/VmHWM:\s+(\d+)/)[1]) / 1024).toFixed(1),
            })
          );
          child.kill("SIGTERM");
        },
        Number(process.env.CALIBRATION_WATCHDOG_MS || 60000)
      );
    } else if (message.type === "heartbeat") {
      ticks++;
      processedRows = message.processedRows;
    } else if (message.type === "result") console.log(JSON.stringify(message.result));
  });
  child.on("exit", () => clearTimeout(deadline));
}
async function main() {
  const count = Number(process.argv[2] || 2216);
  if (process.argv.includes("--watchdog")) {
    watchdog(count);
    return;
  }
  const f = await fixture(
    count,
    90,
    process.argv.includes("--baseline") ? baselineRoot() : undefined
  );
  try {
    const result = await measure(f, {
      count,
      cancel: process.argv.includes("--cancel"),
      cancelAfterRows: process.argv.includes("--active") ? 10 : 0,
    });
    if (process.send) process.send({ type: "result", result });
    else console.log(JSON.stringify(result));
  } finally {
    f.close();
  }
  if (process.connected) process.disconnect();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
