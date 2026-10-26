const fs = require("node:fs");
const path = require("node:path");
const { buildSync } = require("esbuild");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "src/helpers/routines/generated/toolAssembly.cjs");
const result = buildSync({
  absWorkingDir: root,
  entryPoints: ["src/services/tools/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  target: "node24",
  minify: true,
  write: false,
  logLevel: "silent",
});
const contents = result.outputFiles[0].contents;
if (process.argv.includes("--check")) {
  if (!fs.existsSync(output) || !fs.readFileSync(output).equals(contents)) {
    console.error("Routine tool assembly is stale; run npm run compile:routine-tools");
    process.exitCode = 1;
  }
} else {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, contents);
}
