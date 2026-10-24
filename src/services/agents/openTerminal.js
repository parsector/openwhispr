const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { validSessionId } = require("./sessionId");

function existingDirectory(folder) {
  try {
    return typeof folder === "string" && fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

function terminalCommands(job, platform = process.platform) {
  if (!validSessionId(job?.sessionId)) throw new Error("no_session");
  if (!["claude", "cursor-agent"].includes(job.harness)) throw new Error("unsupported_harness");
  const folder =
    job.mode === "write" && job.worktreePath && !job.discardedAt
      ? job.worktreePath
      : job.project?.folder;
  if (!existingDirectory(folder)) throw new Error("folder_missing");
  const command = job.harness;
  const args = ["--resume", job.sessionId];
  if (platform === "darwin") {
    const script = `on run argv\n  tell application "Terminal"\n    activate\n    do script "cd " & quoted form of (item 1 of argv) & " && ${command} --resume " & quoted form of (item 2 of argv)\n  end tell\nend run`;
    return [
      { file: "/usr/bin/osascript", args: ["-e", script, folder, job.sessionId], cwd: folder },
    ];
  }
  if (platform === "win32")
    return [
      { file: "wt", args: ["-d", folder, command, ...args], cwd: folder },
      {
        file: "cmd",
        args: ["/d", "/v:off", "/c", "start", '""', "/D", ".", command, ...args],
        cwd: folder,
      },
    ];
  return [
    { file: "x-terminal-emulator", args: ["-e", command, ...args], cwd: folder },
    { file: "gnome-terminal", args: ["--", command, ...args], cwd: folder },
    { file: "konsole", args: ["-e", command, ...args], cwd: folder },
  ];
}

async function openTerminal(job, { platform = process.platform, spawnImpl = spawn } = {}) {
  const candidates = terminalCommands(job, platform);
  for (const candidate of candidates) {
    try {
      await new Promise((resolve, reject) => {
        const child = spawnImpl(candidate.file, candidate.args, {
          cwd: candidate.cwd,
          shell: false,
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref?.();
          resolve();
        });
      });
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error("terminal_missing");
}

module.exports = { terminalCommands, openTerminal };
