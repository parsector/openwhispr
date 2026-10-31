#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { sweepCalibration } = require('../src/helpers/speakerCalibration');

function wavInfo(file) {
  const header = Buffer.alloc(44);
  const fd = fs.openSync(file, 'r');
  try { if (fs.readSync(fd, header, 0, 44, 0) !== 44 || header.toString('ascii', 0, 4) !== 'RIFF' ||
    header.toString('ascii', 8, 12) !== 'WAVE' || header.toString('ascii', 36, 40) !== 'data' ||
    header.readUInt16LE(20) !== 1 || header.readUInt16LE(22) !== 1 || header.readUInt16LE(34) !== 16)
    throw Error(`Expected mono PCM16 WAV: ${file}`); }
  finally { fs.closeSync(fd); }
  return { rate: header.readUInt32LE(24), duration: header.readUInt32LE(40) / header.readUInt32LE(28) };
}

function voicedSeconds(file, start, end) {
  const { rate } = wavInfo(file);
  const fd = fs.openSync(file, 'r');
  let voiced = 0;
  try {
    const frame = Math.round(rate * .02);
    const bytes = Buffer.alloc(frame * 2);
    for (let sample = Math.round(start * rate); sample + frame <= Math.round(end * rate); sample += frame) {
      const count = fs.readSync(fd, bytes, 0, bytes.length, 44 + sample * 2);
      if (count !== bytes.length) break;
      let power = 0;
      for (let i = 0; i < frame; i++) power += (bytes.readInt16LE(i * 2) / 32768) ** 2;
      // Energy proxy, still an uncalibrated guess. Recorded in the report.
      if (Math.sqrt(power / frame) >= .01) voiced += frame / rate;
    }
  } finally { fs.closeSync(fd); }
  return Math.round(voiced * 1000) / 1000;
}

function embeddingWindow(file, start, end) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let offset = 12, rate = 0, dataOffset = -1;
    while (offset + 8 <= size) {
      const chunk = Buffer.alloc(8);
      fs.readSync(fd, chunk, 0, 8, offset);
      const length = chunk.readUInt32LE(4);
      if (chunk.toString('ascii', 0, 4) === 'fmt ') {
        const fmt = Buffer.alloc(16); fs.readSync(fd, fmt, 0, 16, offset + 8);
        if (fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(2) !== 1 || fmt.readUInt16LE(14) !== 16)
          throw Error('Resampled audio is not mono PCM16');
        rate = fmt.readUInt32LE(4);
      }
      if (chunk.toString('ascii', 0, 4) === 'data') { dataOffset = offset + 8; break; }
      offset += 8 + length + length % 2;
    }
    if (dataOffset < 0 || rate !== 16000) throw Error('Resampled audio is missing 16 kHz PCM data');
    const first = Math.floor(Math.max(start, end - 8) * rate);
    const samples = Math.floor(end * rate) - first;
    const bytes = Buffer.alloc(samples * 2);
    const count = fs.readSync(fd, bytes, 0, bytes.length, dataOffset + first * 2);
    if (count !== bytes.length) throw Error('Labelled row extends past audio duration');
    const values = new Float32Array(samples);
    for (let i = 0; i < samples; i++) values[i] = bytes.readInt16LE(i * 2) / 32768;
    return values;
  } finally { fs.closeSync(fd); }
}

async function measureRows(base, labels) {
  const rows = labels.rows.map(row => ({ ...row }));
  const files = {};
  for (const [track, audio] of Object.entries(labels.audio)) {
    const file = path.resolve(base, audio.file);
    if (!file.startsWith(base + path.sep) || !fs.statSync(file).isFile()) throw Error(`Invalid audio file: ${audio.file}`);
    files[track] = file;
  }
  const durationSeconds = Math.max(...Object.values(files).map(file => wavInfo(file).duration));
  for (const row of rows) {
    if (!files[row.track] || !Number.isFinite(row.start) || !Number.isFinite(row.end) || row.end <= row.start ||
      row.start < 0 || row.end > wavInfo(files[row.track]).duration + .001 ||
      typeof row.truePerson !== 'string' || !row.truePerson || typeof row.trueOverlap !== 'boolean')
      throw Error(`Review truePerson, trueOverlap, start and end for row ${row.rowId}`);
    row.voicedSeconds = labels.synthetic && Number.isFinite(row.voicedSeconds) ? row.voicedSeconds
      : voicedSeconds(files[row.track], row.start, row.end);
    row.overlapSeconds = labels.synthetic && Number.isFinite(row.overlapSeconds) ? row.overlapSeconds
      : Math.max(0, ...rows.filter(other => other !== row && other.track === row.track &&
        other.truePerson !== row.truePerson && Number.isFinite(other.end))
        .map(other => Math.min(row.end, other.end) - Math.max(row.start, other.start)));
  }
  if (!labels.synthetic) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhispr-calibration-'));
    let embeddings;
    try {
      const { getFFmpegPath } = require('../src/helpers/ffmpegUtils');
      embeddings = require('../src/helpers/speakerEmbeddings');
      if (!embeddings.isAvailable()) throw Error('Local speaker embedding model unavailable; run npm run download:diarization-models, then calibrate again');
      const converted = {};
      for (const [track, file] of Object.entries(files)) {
        converted[track] = path.join(temp, `${track}-16k.wav`);
        const result = spawnSync(getFFmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', file,
          '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', converted[track]], { windowsHide: true });
        if (result.status !== 0) throw Error(`Could not resample ${track} audio: ${result.stderr}`);
      }
      const vectors = [];
      for (const row of rows) vectors.push(await embeddings.extractEmbeddingFromSamples(
        embeddingWindow(converted[row.track], row.start, row.end)));
      const cohorts = new Map();
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].trueOverlap || !vectors[i]) continue;
        const cohort = cohorts.get(rows[i].truePerson) ||
          { sum: new Float64Array(vectors[i].length), count: 0 };
        for (let j = 0; j < vectors[i].length; j++) cohort.sum[j] += vectors[i][j];
        cohort.count++;
        cohorts.set(rows[i].truePerson, cohort);
      }
      if (cohorts.size < 2) throw Error('Need at least two reviewed people with non-overlap rows');
      for (let i = 0; i < rows.length; i++) {
        if (!vectors[i]) throw Error(`Row ${rows[i].rowId} is too short for speaker embedding; review or exclude it`);
        const ranked = [...cohorts].map(([person, cohort]) => {
          const leaveOut = !rows[i].trueOverlap && rows[i].truePerson === person;
          const count = cohort.count - Number(leaveOut);
          if (!count) throw Error(`Need at least two non-overlap rows for person ${person}`);
          const centroid = Float32Array.from(cohort.sum,
            (value, j) => (value - (leaveOut ? vectors[i][j] : 0)) / count);
          return { name: person, score: embeddings.cosineSimilarity(vectors[i], centroid) };
        }).sort((a, b) => b.score - a.score);
        rows[i].bestName = ranked[0].name;
        rows[i].bestScore = ranked[0].score;
        rows[i].runnerUpScore = ranked[1]?.score ?? 0;
      }
    } finally {
      if (embeddings) await embeddings.unload().catch(() => {});
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
  const audioSha256 = Object.fromEntries(Object.entries(files).map(([track, file]) => {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
      const chunk = Buffer.alloc(1024 * 1024);
      let count;
      while ((count = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, count));
    } finally { fs.closeSync(fd); }
    return [track, hash.digest('hex')];
  }));
  return { rows, durationSeconds, audioSha256 };
}

async function main() {
  const flag = process.argv.indexOf('--meeting');
  if (flag < 0 || !process.argv[flag + 1]) throw Error('Usage: npm run calibrate -- --meeting <exported-folder>');
  const base = path.resolve(process.argv[flag + 1]);
  const labels = JSON.parse(fs.readFileSync(path.join(base, 'labels.json'), 'utf8'));
  if (labels.version !== 1 || !Array.isArray(labels.rows)) throw Error('Expected app-exported labels.json version 1');
  const measured = await measureRows(base, labels);
  const result = sweepCalibration(measured.rows, measured.durationSeconds);
  const report = { version: 1, synthetic: !!labels.synthetic, generatedAt: new Date().toISOString(),
    audioSha256: measured.audioSha256, methods: {
      similarity: labels.synthetic ? 'fixture values' : 'leave-one-row-out local CAMPPlus embedding centroids',
      voicedDuration: labels.synthetic ? 'fixture values' : '20 ms RMS above 0.01 (uncalibrated energy proxy)',
      overlap: labels.synthetic ? 'fixture values' : 'cross-person transcript interval intersection (approximate)' },
    ...result };
  const reportPath = path.join(base, 'calibration-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`Calibration dataset: ${report.synthetic ? 'SYNTHETIC FIXTURE — NOT OWNER DATA' : 'owner-reviewed local audio'}`);
  console.log(`Rows: ${result.evidence.rowCount}; duration: ${measured.durationSeconds.toFixed(2)}s`);
  console.log('floor margin voiced_s overlap_s right_person refusal overlap_detect wrong');
  for (const row of result.table) console.log([row.similarityFloor, row.runnerUpMargin,
    row.minimumVoicedSeconds, row.overlapToleranceSeconds,
    row.rightPersonRate?.toFixed(3) ?? 'n/a', row.refusalRate?.toFixed(3) ?? 'n/a',
    row.overlapDetectionRate?.toFixed(3) ?? 'n/a', row.wrong].join('  '));
  console.log(`\nCurrent: ${JSON.stringify(result.metrics)}`);
  console.log(`Recommended: ${JSON.stringify(result.recommended)}`);
  console.log(`Evidence: ${JSON.stringify(result.evidence)}`);
  console.log(`Report: ${reportPath}`);
  console.log('Apply explicitly in Settings → People. No setting was changed.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
