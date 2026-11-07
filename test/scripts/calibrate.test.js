const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("gap 3: CLI excludes fallback rows before measurement, overlap and scoring", (t) => {
  const directory = fs.mkdtempSync(
    path.join(__dirname, "../../node_modules/.cache/calibrate-gaps-")
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = spawnSync(
    process.execPath,
    ["scripts/fixtures/create-synthetic-calibration.js", directory],
    { encoding: "utf8" }
  );
  assert.equal(fixture.status, 0, fixture.stderr);
  const file = path.join(directory, "labels.json");
  const labels = JSON.parse(fs.readFileSync(file));
  labels.rows.forEach((row) =>
    Object.assign(row, { timingProvenance: "exact_stored_span", from: row.start, to: row.end })
  );
  labels.rows.push({
    ...labels.rows[0],
    rowId: "unbounded",
    truePerson: "Intruder",
    timingProvenance: "completion_timestamp_fallback",
    voicedSeconds: undefined,
    overlapSeconds: undefined,
  });
  fs.writeFileSync(file, JSON.stringify(labels));
  const result = spawnSync(process.execPath, ["scripts/calibrate.js", "--meeting", directory], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(directory, "calibration-report.json")));
  assert.equal(report.evidence.rowCount, 4);
  assert.equal(report.evidence.exclusionCounts.window_completion_timestamp_fallback, 1);
  assert.deepEqual(report.evidence.exclusions, [
    { rowId: "unbounded", reason: "window_completion_timestamp_fallback" },
  ]);
});

for (const [name, start, end, from, to, sampleCount, reason, retainedTrack] of [
  ["a stored span one sample shorter than 1.5 seconds", 24001 / 24000, 60000 / 24000,
    1, 2.5, 240000, "span_too_short"],
  ["a resolved window rounded past retained samples", 1, 3, 0.96, 3.001,
    72013, "window_retained_coverage"],
  ["a resolved window rounded into silence padding in an export", 1, 3, 0.96, 3.001,
    240000, "window_retained_coverage", {
      sampleCount: 240000,
      chunks: [{ startSample: 0, sampleCount: 72013 }, { startSample: 96000, sampleCount: 144000 }],
    }],
]) {
  test(`CLI rejects ${name}`, (t) => {
    const directory = fs.mkdtempSync(path.join(__dirname, "../../node_modules/.cache/calibrate-window-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const fixture = spawnSync(process.execPath,
      ["scripts/fixtures/create-synthetic-calibration.js", directory], { encoding: "utf8" });
    assert.equal(fixture.status, 0, fixture.stderr);
    const file = path.join(directory, "labels.json");
    const labels = JSON.parse(fs.readFileSync(file));
    const wav = fs.readFileSync(path.join(directory, "system.wav")).subarray(0, 44 + sampleCount * 2);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.writeUInt32LE(sampleCount * 2, 40);
    fs.writeFileSync(path.join(directory, "boundary.wav"), wav);
    labels.audio.boundary = { file: "boundary.wav", retainedTrack };
    labels.rows.push({ ...labels.rows[0], rowId: "boundary", track: "boundary", start, end, from, to });
    fs.writeFileSync(file, JSON.stringify(labels));
    const result = spawnSync(process.execPath, ["scripts/calibrate.js", "--meeting", directory], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(directory, "calibration-report.json")));
    assert.deepEqual(report.evidence.exclusions, [{ rowId: "boundary", reason }]);
    assert.equal(report.evidence.rowCount, 4);
  });
}

test("CLI embeds the app's rounded source window before resampling", (t) => {
  const directory = fs.mkdtempSync(path.join(__dirname, "../../node_modules/.cache/calibrate-pcm-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = spawnSync(process.execPath,
    ["scripts/fixtures/create-synthetic-calibration.js", directory], { encoding: "utf8" });
  assert.equal(fixture.status, 0, fixture.stderr);
  const file = path.join(directory, "labels.json");
  const labels = JSON.parse(fs.readFileSync(file));
  labels.synthetic = false;
  labels.rows.forEach((row, i) => Object.assign(row, {
    start: i * 2 + 0.14, end: i * 2 + 1.94,
    from: i * 2 + 0.10005, to: i * 2 + 1.98002, trueOverlap: false,
  }));
  fs.writeFileSync(file, JSON.stringify(labels));
  const wav = fs.readFileSync(path.join(directory, "system.wav"));
  for (let i = 0; i < 240000; i++) wav.writeInt16LE(i % 30000 - 15000, 44 + i * 2);
  fs.writeFileSync(path.join(directory, "system.wav"), wav);
  const result = spawnSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    const labels = require(require('node:path').join(process.argv[1], 'labels.json'));
    const file = require.resolve('./src/helpers/speakerEmbeddings');
    let calls = 0;
    require.cache[file] = { id: file, filename: file, loaded: true, exports: {
      isAvailable: () => true,
      extractEmbeddingFromSamples: async (samples) => {
        const row = labels.rows[calls++];
        const first = Math.round(row.from * 24000), last = Math.round(row.to * 24000);
        assert.equal(samples.length, Math.floor((last - first) * 16000 / 24000));
        for (let i = 0; i < samples.length; i++)
          assert.equal(samples[i], ((first + Math.floor(i * 24000 / 16000)) % 30000 - 15000) / 32768);
        return row.truePerson === 'A' ? [1, 0] : [0, 1];
      },
      cosineSimilarity: (a, b) => a[0] * b[0] + a[1] * b[1],
      unload: async () => assert.equal(calls, 4),
    } };
    process.argv = [process.execPath, 'scripts/calibrate.js', '--meeting', process.argv[1]];
    require('./scripts/calibrate');
  `, directory], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(directory, "calibration-report.json")));
  assert.equal(report.evidence.rowCount, 4);
});
