#!/usr/bin/env node
// Synthetic performance fixture. It cannot produce owner-calibrated settings.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const ort = require("onnxruntime-node");
const { buildReport } = require("../../src/helpers/speakerInAppCalibration");

async function main() {
  const modelPath = process.argv[2];
  const count = Number(process.argv[3] || 400);
  if (!modelPath || !fs.existsSync(modelPath) || !Number.isInteger(count) || count < 3)
    throw Error(
      "Usage: node scripts/fixtures/benchmark-in-app-calibration.js <CAMPPlus model> [rows]"
    );
  const source = fs.readFileSync(path.join(__dirname, "../../src/workers/onnxWorker.js"), "utf8");
  const fbankSource = source.slice(
    source.indexOf("const FBANK_SAMPLE_RATE"),
    source.indexOf("async function speakerLoad")
  );
  const computeFbank = vm.runInNewContext(`${fbankSource}\ncomputeFbank`, { os, require, console });
  const session = await ort.InferenceSession.create(modelPath, {
    intraOpNumThreads: 2,
    executionMode: "sequential",
  });
  const input = session.inputNames[0];
  const samples = [0, 1, 2].map((person) =>
    Float32Array.from(
      { length: 32000 },
      (_, i) => 0.2 * Math.sin((2 * Math.PI * (140 + person * 65) * i) / 16000)
    )
  );
  const temp = fs.mkdtempSync(
    path.join(process.env.FIXTURE_DIR || os.tmpdir(), "speaker-calibration-fixture-")
  );
  const audioFiles = samples.map((sample, person) => {
    const pcm = Buffer.alloc(sample.length * 2);
    for (let i = 0; i < sample.length; i++) pcm.writeInt16LE(Math.round(sample[i] * 32767), i * 2);
    const file = path.join(temp, `${person}.ogg`);
    const encode = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-c:a",
        "libopus",
        "-b:a",
        "32k",
        "-vbr",
        "off",
        file,
      ],
      { input: pcm }
    );
    if (encode.status !== 0) throw Error(`Opus encoding failed: ${encode.stderr}`);
    const decode = spawnSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      file,
      "-f",
      "s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      "pipe:1",
    ]);
    if (decode.status !== 0) throw Error(`Opus decoding failed: ${decode.stderr}`);
    samples[person] = Float32Array.from(
      { length: decode.stdout.length / 2 },
      (_, i) => decode.stdout.readInt16LE(i * 2) / 32768
    );
    return file;
  });
  const hashes = audioFiles.map((file) =>
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
  );
  const rows = [];
  let bytesRead = 0;
  const started = performance.now();
  for (let i = 0; i < count; i++) {
    const person = i % 3;
    const fbank = computeFbank(samples[person]);
    const result = await session.run({
      [input]: new ort.Tensor("float32", new Float32Array(fbank.features), [
        1,
        fbank.numFrames,
        80,
      ]),
    });
    const vector = Array.from(result[Object.keys(result)[0]].data);
    bytesRead += fs.readFileSync(audioFiles[person]).length;
    rows.push({
      noteId: 1 + Math.floor((i * 12) / count),
      rowId: `synthetic-${i}`,
      revision: hashes[person],
      clusterId: String(person),
      truePerson: ["Ada", "Ben", "Cora"][person],
      machineLabel: ["Ada", "Ben", "Cora"][person],
      vector,
      liveVector: vector,
      audioFingerprint: hashes[person],
    });
    if (i && i % 100 === 0) process.stderr.write(`rows=${i}\n`);
  }
  const elapsedMs = Math.round(performance.now() - started);
  const profiles = [0, 1, 2].map((person) => ({
    id: person + 1,
    name: ["Ada", "Ben", "Cora"][person],
    vector: rows.find((row) => row.truePerson === ["Ada", "Ben", "Cora"][person]).vector,
  }));
  const report = buildReport({
    rows,
    profiles,
    scope: { kind: "all" },
    synthetic: true,
    modelFingerprint: crypto.createHash("sha256").update(fs.readFileSync(modelPath)).digest("hex"),
    bytesRead,
  });
  await session.release();
  for (const file of audioFiles) fs.unlinkSync(file);
  fs.rmdirSync(temp);
  console.log(
    JSON.stringify(
      {
        fixture:
          "synthetic 32 kb/s Opus sine-wave clips; decoded once before timing, then model inference and repeated compressed-byte reads",
        notes: 12,
        people: 3,
        reviewedRows: count,
        reembeddedRows: count,
        bytesRead,
        elapsedMs,
        secondsPerRow: elapsedMs / count / 1000,
        twoHourAtThisRowBudgetSeconds: elapsedMs / 1000,
        report: {
          synthetic: report.synthetic,
          evidence: { ...report.evidence, revisions: undefined },
          exact: { rows: report.analyses.exact.rows, winner: report.analyses.exact.winner },
          estimated: {
            label: report.analyses.estimated.label,
            rows: report.analyses.estimated.rows,
          },
          support: report.support,
          recommended: report.recommended,
        },
      },
      null,
      2
    )
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
