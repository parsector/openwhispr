import fs from "node:fs";

const [version, outputPath = "release-notes.md"] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  throw new Error("Usage: node scripts/extract-release-notes.mjs <version> [output file]");
}

const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
const lines = changelog.split(/\r?\n/);
const start = lines.findIndex((line) => line.startsWith(`## [${version}] - `));
if (start === -1) throw new Error(`CHANGELOG.md is missing the ## [${version}] release section`);
const next = lines.findIndex((line, index) => index > start && /^## \[/.test(line));
const section = lines
  .slice(start + 1, next === -1 ? undefined : next)
  .join("\n")
  .trim();
if (!section) throw new Error(`CHANGELOG.md has an empty ## [${version}] release section`);
fs.writeFileSync(outputPath, `${section}\n`);
console.log(`Extracted ${version} release notes to ${outputPath}`);
