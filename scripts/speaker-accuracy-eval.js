#!/usr/bin/env node
// Manifest (paths relative to this JSON file):
// { "audio":"meeting.wav", "sha256":"<64 hex>", "durationSeconds":900,
//   "truth":[{"rowId":"stored-row-id","person":"Alex","overlap":false}],
//   "final":"final-before-review.json", "actions":"owner-review-action-log.json" }
// Export final rows immediately after stop analysis, before human corrections.
// The optional action log is captured after the owner finishes reviewing; when
// absent, correction effort is null rather than an invented zero.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { readTranscriptDocument } = require("../src/helpers/transcriptDocument");
const { evaluateSpeakerAccuracy } = require("./lib/speaker-accuracy-eval");

function main() {
  const flag = process.argv.indexOf("--manifest");
  if (flag < 0 || !process.argv[flag + 1]) {
    throw Error("Usage: node scripts/speaker-accuracy-eval.js --manifest labelled-meeting.json");
  }
  const manifestPath = path.resolve(process.argv[flag + 1]);
  const base = path.dirname(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const audioPath = path.resolve(base, manifest.audio || "");
  if (!manifest.audio || !fs.statSync(audioPath).isFile()) throw Error("Labelled audio is required");
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(audioPath, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, count));
  } finally { fs.closeSync(fd); }
  const digest = hash.digest("hex");
  if (!manifest.sha256 || digest !== manifest.sha256) throw Error("Audio SHA-256 does not match manifest");
  const final = JSON.parse(fs.readFileSync(path.resolve(base, manifest.final), "utf8"));
  const rows = Array.isArray(final) ? final : readTranscriptDocument(
    typeof final.transcript === "string" ? final.transcript : JSON.stringify(final)).rows;
  const actions = manifest.actions ? JSON.parse(fs.readFileSync(path.resolve(base, manifest.actions), "utf8")).actions : null;
  const result = evaluateSpeakerAccuracy(manifest.truth, rows, manifest.durationSeconds, actions);
  process.stdout.write(JSON.stringify({ audioSha256: digest, ...result }, null, 2) + "\n");
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
