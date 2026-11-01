const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('owner calibration sweeps thresholds and recommends the strongest measured outcome', () => {
  const { sweepCalibration } = require('../../src/helpers/speakerCalibration');
  const rows = [
    { rowId: 'a', truePerson: 'A', bestName: 'A', bestScore: .8, runnerUpScore: .4, voicedSeconds: 2, overlapSeconds: 0, trueOverlap: false, currentLabel: 'A', corrected: false },
    { rowId: 'b', truePerson: 'B', bestName: 'B', bestScore: .62, runnerUpScore: .45, voicedSeconds: 2, overlapSeconds: 0, trueOverlap: false, currentLabel: 'B', corrected: true },
    { rowId: 'c', truePerson: 'B', bestName: 'A', bestScore: .57, runnerUpScore: .54, voicedSeconds: 2, overlapSeconds: 0, trueOverlap: false, currentLabel: 'B', corrected: true },
    { rowId: 'd', truePerson: 'A', bestName: 'A', bestScore: .8, runnerUpScore: .4, voicedSeconds: 2, overlapSeconds: .12, trueOverlap: true, currentLabel: null, corrected: false },
  ];
  const result = sweepCalibration(rows, 60, { similarityFloor: [.55, .6], runnerUpMargin: [.02, .05], minimumVoicedSeconds: [1.5], overlapToleranceSeconds: [.1, .2] });
  assert.equal(result.table.length, 8);
  assert.deepEqual(result.recommended, { similarityFloor: .6, runnerUpMargin: .05,
    minimumVoicedSeconds: 1.5, overlapToleranceSeconds: .1 });
  assert.equal(result.metrics.correctionsPerMinute, 2);
  assert.equal(result.table[0].overlapDetectionRate, 1);
});

test('app export preserves row identity, timing, label and correction provenance without inventing truth', () => {
  const { buildCalibrationLabels } = require('../../src/helpers/speakerCalibrationExport');
  const note = { transcript: JSON.stringify([{ id: 'row-a', text: 'Hello.', source: 'system',
    speakerName: 'Speaker A', audioSpan: { trackId: 'system', startSample: 24000, endSample: 48000 },
    finalRevision: { fromName: null, toName: 'Speaker A' } }]),
    speaker_action_log: JSON.stringify({ version: 1, actions: [{ kind: 'correction', id: 'one', sequence: 1,
      event: { actor: 'user', affectedRowIds: ['row-a'], snapshots: {
        'row-a': { previous: { speakerName: 'Speaker B', speakerStatus: 'confirmed' }, next: { speakerName: 'Speaker A' } } } } }] }) };
  const [row] = buildCalibrationLabels(note, { system: { file: 'system.wav', durationSeconds: 2 } }).rows;
  assert.equal(row.rowId, 'row-a');
  assert.equal(row.start, 1);
  assert.equal(row.end, 2);
  assert.equal(row.currentLabel, 'Speaker A');
  assert.equal(row.machineLabel, 'Speaker B');
  assert.equal(row.corrected, true);
  assert.deepEqual(row.ownerCorrectionActionIds, ['one']);
  assert.equal(row.finalPassChanged, true);
  assert.match(row.textHash, /^[0-9a-f]{64}$/);
  assert.equal(row.truePerson, null);
});

test("owner first names an unknown speaker without creating a machine claim", () => {
  const { buildCalibrationLabels } = require("../../src/helpers/speakerCalibrationExport");
  const rowId = "row-tasos";
  const actionId = "43cc33f2-owner-correction";
  const note = {
    transcript: JSON.stringify([
      {
        id: rowId,
        text: "Hello.",
        source: "system",
        speakerName: "tasos",
        speakerLocked: true,
        speakerLockSource: "user",
      },
    ]),
    speaker_action_log: JSON.stringify({
      version: 1,
      actions: [
        {
          kind: "correction",
          id: actionId,
          sequence: 1,
          event: {
            actor: "user",
            affectedRowIds: [rowId],
            initialAttribution: true,
            snapshots: {
              [rowId]: {
                previous: { speakerIsPlaceholder: true },
                next: { speakerName: "tasos", speakerLockSource: "user" },
              },
            },
          },
        },
      ],
    }),
  };
  const [row] = buildCalibrationLabels(note, {}).rows;
  assert.equal(row.currentLabel, "tasos");
  assert.equal(row.machineLabel, null);
  assert.equal(row.machineLabelUnavailable, "no_machine_assignment");
  assert.equal(row.corrected, true);
  assert.deepEqual(row.ownerCorrectionActionIds, [actionId]);
  assert.equal(row.truePerson, null);
  assert.equal(row.trueOverlap, null);
});

test("missing correction snapshot leaves machine label unavailable", () => {
  const { buildCalibrationLabels } = require("../../src/helpers/speakerCalibrationExport");
  const note = {
    transcript: JSON.stringify([
      {
        id: "legacy",
        text: "Hello.",
        source: "system",
        speakerName: "tasos",
        speakerLockSource: "user",
      },
    ]),
    speaker_action_log: JSON.stringify({
      version: 1,
      actions: [
        { kind: "correction", id: "old", event: { actor: "user", affectedRowIds: ["legacy"] } },
      ],
    }),
  };
  const [row] = buildCalibrationLabels(note, {}).rows;
  assert.equal(row.machineLabel, null);
  assert.equal(row.machineLabelUnavailable, "missing_snapshot");
  assert.equal(row.currentLabel, "tasos");
});

test("export keeps the last recorded machine assignment through later owner corrections", () => {
  const { buildCalibrationLabels } = require("../../src/helpers/speakerCalibrationExport");
  const note = {
    transcript: JSON.stringify([
      {
        id: "row-a",
        source: "system",
        text: "Hello.",
        speakerName: "tasos",
        speakerLockSource: "user",
      },
    ]),
    speaker_action_log: JSON.stringify({
      version: 1,
      actions: [
        {
          kind: "correction",
          id: "owner",
          sequence: 3,
          event: {
            actor: "user",
            affectedRowIds: ["row-a"],
            snapshots: {
              "row-a": {
                previous: { speakerName: "Machine B", speakerStatus: "confirmed" },
                next: { speakerName: "tasos", speakerLockSource: "user" },
              },
            },
          },
        },
        {
          kind: "reconsideration",
          id: "machine",
          sequence: 2,
          event: {
            actor: "machine",
            affectedRowIds: ["row-a"],
            snapshots: {
              "row-a": {
                previous: { speakerName: "Machine A" },
                next: { speakerName: "Machine B", speakerStatus: "confirmed" },
              },
            },
          },
        },
      ],
    }),
  };
  const [row] = buildCalibrationLabels(note, {}).rows;
  assert.equal(row.machineLabel, "Machine B");
  assert.equal(row.currentLabel, "tasos");
  assert.equal(row.machineLabelUnavailable, undefined);
});

test("the pre-correction snapshot wins over an older machine action", () => {
  const { buildCalibrationLabels } = require("../../src/helpers/speakerCalibrationExport");
  const note = {
    transcript: JSON.stringify([{ id: "row-a", source: "system", text: "Hello.",
      speakerName: "tasos", speakerLockSource: "user" }]),
    speaker_action_log: JSON.stringify({ version: 1, actions: [
      { kind: "reconsideration", id: "machine", sequence: 1, event: { actor: "machine",
        affectedRowIds: ["row-a"], snapshots: { "row-a": {
          previous: {}, next: { speakerName: "Machine A", speakerStatus: "confirmed" },
        } } } },
      { kind: "correction", id: "owner", sequence: 2, event: { actor: "user",
        affectedRowIds: ["row-a"], snapshots: { "row-a": {
          previous: { speakerName: "Machine B", speakerStatus: "confirmed" },
          next: { speakerName: "tasos", speakerLockSource: "user" },
        } } } },
    ] }),
  };
  const [row] = buildCalibrationLabels(note, {}).rows;
  assert.equal(row.machineLabel, "Machine B");
});

test("a person rename cannot become a machine claim before a later correction", () => {
  const { buildCalibrationLabels } = require("../../src/helpers/speakerCalibrationExport");
  const note = {
    transcript: JSON.stringify([{ id: "row-a", source: "system", text: "Hello.",
      speakerName: "tasos", speakerLockSource: "user" }]),
    speaker_action_log: JSON.stringify({ version: 1, actions: [
      { kind: "person", id: "rename", sequence: 1, action: "rename",
        before: [{ id: "row-a", speakerName: "Machine A" }] },
      { kind: "correction", id: "owner", sequence: 2, event: { actor: "user",
        affectedRowIds: ["row-a"], snapshots: { "row-a": {
          previous: { speakerName: "Owner Renamed", speakerStatus: "confirmed" },
          next: { speakerName: "tasos", speakerLockSource: "user" },
        } } } },
    ] }),
  };
  const [row] = buildCalibrationLabels(note, {}).rows;
  assert.equal(row.machineLabel, null);
  assert.equal(row.machineLabelUnavailable, "owner_person_change");
  assert.equal(row.currentLabel, "tasos");
});

test("a renamed person without a correction has no provable machine label", () => {
  const { buildCalibrationLabels } = require("../../src/helpers/speakerCalibrationExport");
  const note = {
    transcript: JSON.stringify([{ id: "row-a", source: "system", text: "Hello.",
      speakerName: "Owner Renamed", speakerStatus: "confirmed" }]),
    speaker_action_log: JSON.stringify({ version: 1, actions: [
      { kind: "person", id: "rename", sequence: 1, action: "rename",
        before: [{ id: "row-a", speakerName: "Machine A" }] },
    ] }),
  };
  const [row] = buildCalibrationLabels(note, {}).rows;
  assert.equal(row.machineLabel, null);
  assert.equal(row.machineLabelUnavailable, "owner_person_change");
});

test("calibration command excludes owner-corrected rows with no machine claim from accuracy", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-calibration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = spawnSync(
    process.execPath,
    ["scripts/fixtures/create-synthetic-calibration.js", dir],
    { encoding: "utf8" }
  );
  assert.equal(fixture.status, 0, fixture.stderr);
  const labelsPath = path.join(dir, "labels.json");
  const labels = JSON.parse(fs.readFileSync(labelsPath, "utf8"));
  labels.rows[1].currentLabel = "tasos";
  labels.rows[1].truePerson = "tasos";
  labels.rows[1].machineLabel = null;
  labels.rows[1].machineLabelUnavailable = "no_machine_assignment";
  labels.rows[1].corrected = true;
  fs.writeFileSync(labelsPath, JSON.stringify(labels));
  const run = spawnSync(process.execPath, ["scripts/calibrate.js", "--meeting", dir], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(dir, "calibration-report.json"), "utf8"));
  assert.equal(report.metrics.rightPersonRate, 0.5);
  assert.equal(report.metrics.machineClaimRowsScored, 2);
  assert.equal(report.metrics.noMachineClaimRows, 1);
  assert.match(report.methods.currentAccuracy, /machine claims only/);
  assert.match(run.stdout, /1 row excluded.*no machine claim/);
});
