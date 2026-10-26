#!/usr/bin/env node

// Use esbuild's metafile, as test/helpers/mainPackageWhitelist.test.js does,
// to follow the repo's static require/import graph. Unseen edges are handled
// conservatively by the fallbacks below.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const CODE_FILE = /\.(?:cjs|js|jsx|mjs|ts|tsx|json)$/;
const SCRIPT_FILE = /\.(?:cjs|js|mjs)$/;

function walk(root, directory, include) {
  const full = path.join(root, directory);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? walk(root, file, include) : include(file) ? [file] : [];
  });
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function changedFilesFromGit(root, { base, head = "HEAD", includeUncommitted = !process.env.CI }) {
  if (!base) throw new Error("--base <git ref> is required");
  let mergeBase;
  try {
    mergeBase = git(root, ["merge-base", base, head]);
  } catch {
    throw new Error(`cannot resolve merge-base for ${base} and ${head}`);
  }
  const changed = new Set(
    execFileSync(
      "git",
      ["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB", mergeBase, head],
      { cwd: root, encoding: "utf8" }
    )
      .split("\0")
      .filter(Boolean)
  );
  if (includeUncommitted) {
    const records = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    }).split("\0");
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record) continue;
      changed.add(record.slice(3));
      if (/^[RC]/.test(record) || /^[RC]/.test(record[1])) index += 1;
    }
  }
  return [...changed].sort();
}

function alwaysRunReason(file) {
  if (["package.json", "package-lock.json", "electron-builder.json"].includes(file)) return file;
  if (file.startsWith(".github/")) return file;
  if (file === "scripts/afterPack.js") return file;
  if (/^scripts\/(?:download|build)-[^/]+\.js$/.test(file)) return file;
  if (file.startsWith("scripts/lib/")) return file;
  if (path.posix.basename(file).includes(".config.")) return file;
  return null;
}

function dependencyGraph(root, tests) {
  const runtimeRoots = ["main.js", "preload.js", ...walk(root, "scripts", (file) => SCRIPT_FILE.test(file))];
  const options = {
    absWorkingDir: root,
    outdir: "unused-affected-test-graph",
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    external: ["electron"],
    loader: {
      ".png": "file",
      ".svg": "file",
      ".jpg": "file",
      ".jpeg": "file",
      ".webp": "file",
      ".gif": "file",
      ".icns": "file",
    },
    write: false,
    metafile: true,
    logLevel: "silent",
  };
  // Separate builds keep esbuild from duplicating the large main bundle into
  // every test output. The metafiles use the same repo-relative input paths.
  const testGraph = esbuild.buildSync({ ...options, entryPoints: tests }).metafile;
  const runtimeGraph = esbuild.buildSync({ ...options, entryPoints: runtimeRoots }).metafile;
  const rendererEntry = "src/main.jsx";
  const rendererGraph = fs.existsSync(path.join(root, rendererEntry))
    ? esbuild.buildSync({ ...options, entryPoints: [rendererEntry], platform: "browser" }).metafile
    : { inputs: {} };
  const reverse = new Map();
  for (const [importer, info] of Object.entries({
    ...runtimeGraph.inputs,
    ...rendererGraph.inputs,
    ...testGraph.inputs,
  })) {
    for (const imported of info.imports) {
      if (imported.external) continue;
      const parents = reverse.get(imported.path) || new Set();
      parents.add(importer);
      reverse.set(imported.path, parents);
    }
  }
  const testSources = new Map();
  for (const output of Object.values(testGraph.outputs)) {
    if (output.entryPoint && tests.includes(output.entryPoint)) {
      testSources.set(output.entryPoint, new Set(Object.keys(output.inputs)));
    }
  }
  if (testSources.size !== tests.length) {
    throw new Error(`dependency graph has ${testSources.size}/${tests.length} test entry points`);
  }
  return { reverse, testSources };
}

function selectForChanges(root, changedFiles) {
  const tests = walk(root, "test", (file) => file.endsWith(".test.js")).sort();
  if (tests.length === 0) throw new Error("no test files found");
  const full = (reason) => ({ files: tests, count: tests.length, total: tests.length, full: true, reason });
  if (changedFiles.length === 0) return full("no changed files; zero-test selection is unsafe");
  for (const file of changedFiles) {
    const trigger = alwaysRunReason(file);
    if (trigger) return full(`always-run path changed: ${trigger}`);
  }

  const known = new Set([
    "main.js",
    "preload.js",
    ...walk(root, "src", (file) => CODE_FILE.test(file)),
    ...walk(root, "scripts", (file) => CODE_FILE.test(file)),
    ...walk(root, "test", (file) => CODE_FILE.test(file)),
  ]);
  for (const file of changedFiles) {
    // A removed test cannot be executed and needs no module resolution.
    if (file.startsWith("test/") && file.endsWith(".test.js") && !fs.existsSync(path.join(root, file))) continue;
    if (!known.has(file)) return full(`changed file cannot be resolved to a known module: ${file}`);
  }

  const { reverse, testSources } = dependencyGraph(root, tests);
  const selected = new Set();
  const testSet = new Set(tests);
  const queue = changedFiles.filter((file) => !testSet.has(file));
  for (const file of changedFiles) if (testSet.has(file)) selected.add(file);
  const visited = new Set();
  while (queue.length) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    if (testSet.has(file)) selected.add(file);
    for (const parent of reverse.get(file) || []) queue.push(parent);
  }

  let unreferenced = 0;
  for (const test of tests) {
    const importsSrc = [...testSources.get(test)].some((file) => file.startsWith("src/"));
    if (!(reverse.get(test)?.size) && !importsSrc) {
      selected.add(test);
      unreferenced += 1;
    }
  }
  if (selected.size === 0) return full("no tests selected; zero-test selection is unsafe");
  const files = [...selected].sort();
  return {
    files,
    count: files.length,
    total: tests.length,
    full: false,
    reason: `${changedFiles.length} changed file(s); ${unreferenced} unreferenced test(s) included`,
  };
}

function parseOptions(args) {
  const options = { includeUncommitted: !process.env.CI, head: "HEAD" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--base" || arg === "--head") options[arg.slice(2)] = args[++index];
    else if (arg === "--json") options.json = true;
    else if (arg === "--run") options.run = true;
    else if (arg === "--include-uncommitted") options.includeUncommitted = true;
    else if (arg === "--no-include-uncommitted") options.includeUncommitted = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.base) throw new Error("--base <git ref> is required");
  if (options.json && options.run) throw new Error("--json and --run cannot be combined");
  return options;
}

function main() {
  try {
    const options = parseOptions(process.argv.slice(2));
    const changedFiles = changedFilesFromGit(ROOT, options);
    const selection = selectForChanges(ROOT, changedFiles);
    const summary = `selected ${selection.count}/${selection.total} test files: ${selection.reason}`;
    console.error(summary);
    if (options.run) {
      if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
      }
      const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...selection.files], {
        cwd: ROOT,
        env: process.env,
        stdio: "inherit",
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    } else if (options.json) {
      console.log(JSON.stringify({ ...selection, changedFiles }));
    } else {
      console.log(selection.files.join("\n"));
    }
  } catch (error) {
    console.error(`select-affected-tests: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { alwaysRunReason, changedFilesFromGit, selectForChanges };
