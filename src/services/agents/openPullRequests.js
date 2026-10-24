const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const { minimalEnv } = require("./minimalEnv");

const run = promisify(execFile);
const ARGV = ["pr", "list", "--json", "number,title,headRefName", "--limit", "20"];

function parseOpenPullRequests(output) {
  try {
    const values = JSON.parse(output);
    if (!Array.isArray(values)) return null;
    return values
      .filter(
        (item) =>
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          Number.isSafeInteger(item.number) &&
          item.number > 0
      )
      .map(({ number, title, headRefName }) => ({
        number,
        title: typeof title === "string" ? title : "",
        headRefName: typeof headRefName === "string" ? headRefName : "",
      }))
      .sort((a, b) => a.number - b.number)
      .slice(0, 20);
  } catch {
    return null;
  }
}

function createOpenPullRequests({ resolver, runImpl = run }) {
  let ghResolution;
  return async (folder) => {
    ghResolution ||= resolver.resolve("gh").catch(() => null);
    const resolved = await ghResolution;
    if (!resolved?.ok || !path.isAbsolute(resolved.path))
      return { ok: false, reason: "gh_missing" };
    try {
      const { stdout } = await runImpl(resolved.path, ARGV, {
        cwd: folder,
        timeout: 5000,
        env: minimalEnv(),
        maxBuffer: 256 * 1024,
      });
      const targets = parseOpenPullRequests(stdout);
      return targets
        ? { ok: true, targets, total: targets.length }
        : { ok: false, reason: "parse_failed" };
    } catch {
      return { ok: false, reason: "parse_failed" };
    }
  };
}

module.exports = { parseOpenPullRequests, createOpenPullRequests, ARGV };
