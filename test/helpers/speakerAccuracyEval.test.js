const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateSpeakerAccuracy } = require("../../scripts/lib/speaker-accuracy-eval");
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

test("labelled rows score correct people, abstention, overlap, changes and correction effort", () => {
  const result = evaluateSpeakerAccuracy([
    { rowId: "a", person: "Alex", overlap: false },
    { rowId: "b", person: "Sam", overlap: false },
    { rowId: "c", person: "Alex", overlap: true },
  ], [
    { id: "a", speakerName: "Alex", changedAfterFinal: true },
    { id: "b", speakerIsPlaceholder: true },
    { id: "c", speakerIsPlaceholder: true, uncertainty: { reason: "overlapping_speech" } },
  ], 120, [{ kind: "correction" }, { kind: "split" }]);
  assert.equal(result.rates.rightPersonAfterFinal, 0.5);
  assert.equal(result.rates.refusal, 2 / 3);
  assert.equal(result.rates.overlapDetection, 1);
  assert.equal(result.rates.finalPassChange, 1 / 3);
  assert.equal(result.rates.correctionsPerMinute, 1);
});

test("correction effort is unavailable without a reviewed action log", () => {
  const result = evaluateSpeakerAccuracy([{ rowId: "a", person: "Alex" }],
    [{ id: "a", speakerName: "Alex" }], 60);
  assert.equal(result.rates.correctionsPerMinute, null);
});

test('CLI derives correction rate from hashed WAV duration, not the manifest claim', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-accuracy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wav = Buffer.alloc(44 + 24000 * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(48000, 40);
  fs.writeFileSync(path.join(dir, 'audio.wav'), wav);
  fs.writeFileSync(path.join(dir, 'final.json'), JSON.stringify([{ id: 'a', speakerName: 'Alex' }]));
  fs.writeFileSync(path.join(dir, 'actions.json'), JSON.stringify({ actions: [{ kind: 'correction' }] }));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ audio: 'audio.wav',
    sha256: crypto.createHash('sha256').update(wav).digest('hex'), durationSeconds: 120,
    truth: [{ rowId: 'a', person: 'Alex' }], final: 'final.json', actions: 'actions.json' }));
  const result = spawnSync(process.execPath, ['scripts/speaker-accuracy-eval.js', '--manifest',
    path.join(dir, 'manifest.json')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.durationSeconds, 1);
  assert.equal(report.rates.correctionsPerMinute, 60);
  assert.equal(report.durationVerified, true);
});
