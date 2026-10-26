const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "../..");
const { files } = require("../../electron-builder.json");

function matches(pattern, file) {
  if (pattern.endsWith("/**/*")) {
    return file.startsWith(`${pattern.slice(0, -5)}/`);
  }
  return pattern === file;
}

function isPackaged(file) {
  return (
    files.some((pattern) => !pattern.startsWith("!") && matches(pattern, file)) &&
    !files.some((pattern) => pattern.startsWith("!") && matches(pattern.slice(1), file))
  );
}

test("every statically reachable main-process file is packaged", () => {
  const result = esbuild.buildSync({
    absWorkingDir: root,
    entryPoints: ["main.js", "preload.js", "src/helpers/ipcHandlers.js"],
    outdir: "unused-main-graph-output",
    bundle: true,
    platform: "node",
    packages: "external",
    external: ["electron"],
    write: false,
    metafile: true,
    logLevel: "silent",
  });

  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.includes("src/services/agents/cliResolver.js"));
  assert.ok(inputs.includes("src/services/tools/mcpTools.ts"));
  assert.ok(inputs.includes("src/helpers/routines/generated/toolAssembly.cjs"));

  const missing = inputs.filter((file) => !isPackaged(file)).sort();
  assert.deepEqual(
    missing,
    [],
    `Main-process files missing from electron-builder.json: ${missing.join(", ")}`
  );
});

test("routine bundle external packages remain in the packaged runtime", () => {
  const source = fs.readFileSync(
    path.join(root, "src/helpers/routines/generated/toolAssembly.cjs"),
    "utf8"
  );
  const dependencies = require("../../package.json").dependencies;
  const packages = [...source.matchAll(/\brequire\("([^".][^"]*)"\)/g)].map((match) => {
    const segments = match[1].split("/");
    return segments[0].startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  });

  assert.ok(packages.includes("react"));
  assert.ok(packages.includes("clsx"));
  assert.ok(packages.includes("tailwind-merge"));
  assert.ok(isPackaged("node_modules/react/index.js"));

  for (const packageName of new Set(packages)) {
    assert.ok(dependencies[packageName], `${packageName} must be a production dependency`);
    assert.ok(
      !files.some(
        (pattern) => pattern.startsWith("!") && pattern.includes(`/node_modules/${packageName}/`)
      ),
      `${packageName} is required by the main-process routine bundle but excluded from the package`
    );
  }
});
