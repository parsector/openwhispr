#!/usr/bin/env node
// Deterministic demonstration only. The numbers below are invented, not owner evidence.
const fs = require('node:fs');
const path = require('node:path');
const folder = path.resolve(process.argv[2] || 'tmp/synthetic-calibration');
fs.mkdirSync(folder, { recursive: true });
const samples = 24000 * 10;
const wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
fs.writeFileSync(path.join(folder, 'system.wav'), wav);
const rows = [
  ['a', 'A', 'A', .8, .4, 0, false, false],
  ['b', 'B', 'B', .62, .45, 0, true, false],
  ['c', 'B', 'A', .57, .54, 0, true, false],
  ['d', 'A', 'A', .8, .4, .12, false, true],
].map(([rowId, truePerson, bestName, bestScore, runnerUpScore, overlapSeconds, corrected, trueOverlap], i) => ({
  rowId, track: 'system', start: i * 2, end: i * 2 + 1.8, textHash: 'synthetic',
  currentLabel: corrected ? truePerson : bestName, machineLabel: bestName,
  corrected, truePerson, trueOverlap, bestName, bestScore, runnerUpScore,
  voicedSeconds: 2, overlapSeconds, currentOverlapDetected: false, finalPassChanged: false,
}));
fs.writeFileSync(path.join(folder, 'labels.json'), JSON.stringify({ version: 1, synthetic: true,
  audio: { system: { file: 'system.wav', durationSeconds: 10 } }, rows }, null, 2));
console.log(folder);
