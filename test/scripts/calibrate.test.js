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
