import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const args = process.argv.slice(2);
const verifyOnly = args[0] === "--verify";
const [feedPath, notesPath, expectedVersion] = verifyOnly ? args.slice(1) : args;
if (!feedPath || !notesPath || !expectedVersion) {
  throw new Error(
    "Usage: node scripts/inject-release-notes.mjs [--verify] <feed.yml> <release-notes.md> <version>"
  );
}

const notes = fs.readFileSync(notesPath, "utf8");
if (!notes.trim()) throw new Error("Release notes are empty");
const original = fs.readFileSync(feedPath, "utf8");
const before = yaml.load(original);
if (!before || typeof before !== "object" || Array.isArray(before))
  throw new Error("Update feed must be a YAML mapping");
if (String(before.version) !== expectedVersion) {
  throw new Error(`Update feed version ${before.version} does not match ${expectedVersion}`);
}

if (!verifyOnly) {
  // Keep electron-builder's existing keys and formatting byte-for-byte.
  // Replace an existing root releaseNotes key, if present, so reruns are safe.
  const lines = original.split("\n");
  const start = lines.findIndex((line) => /^releaseNotes:(?:\s|$)/.test(line));
  let source = original;
  if (start !== -1) {
    let end = start + 1;
    while (end < lines.length && (lines[end].trim() === "" || /^[ \t]/.test(lines[end]))) end++;
    source = [...lines.slice(0, start), ...lines.slice(end)].join("\n");
  }
  const trailingNewlines = (notes.match(/\n*$/)?.[0] ?? "").length;
  const indicator = trailingNewlines === 0 ? "|-" : trailingNewlines === 1 ? "|" : "|+";
  const contentLines = trailingNewlines ? notes.slice(0, -1).split("\n") : notes.split("\n");
  const block = `releaseNotes: ${indicator}\n${contentLines.map((line) => `  ${line}`).join("\n")}\n`;
  fs.writeFileSync(feedPath, `${source.endsWith("\n") ? source : `${source}\n`}${block}`);
}

const after = yaml.load(fs.readFileSync(feedPath, "utf8"));
if (String(after.version) !== expectedVersion) throw new Error("Update feed version changed");
if (after.releaseNotes !== notes)
  throw new Error("Update feed releaseNotes do not match release-notes.md");
const withoutNotes = ({ releaseNotes: _releaseNotes, ...otherKeys }) => otherKeys;
if (JSON.stringify(withoutNotes(after)) !== JSON.stringify(withoutNotes(before))) {
  throw new Error("Update feed keys changed during releaseNotes injection");
}
console.log(
  `Verified ${feedPath}: version ${expectedVersion}, releaseNotes ${notes.length} characters`
);
