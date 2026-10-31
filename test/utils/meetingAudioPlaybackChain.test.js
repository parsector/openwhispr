const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MeetingAudioStore, RATE } = require('../../src/helpers/meetingAudioStore');
const fakeCodec = require('../lib/fakeAudioCodec');
const { rebaseDiarizedRows, attachUndiarizedAudioSpans, extendBatchCapture } = require('../../src/helpers/meetingAudioTimebase');
const { readTranscriptDocument } = require('../../src/helpers/transcriptDocument');

const ORIGIN = 1_700_000_000_000;
function tone(frequency) {
  const pcm = Buffer.alloc(5 * RATE * 2);
  for (let i = RATE; i < Math.round(1.6 * RATE); i++)
    pcm.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * frequency * i / RATE)), i * 2);
  return pcm;
}
function correlation(actual, expected) {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < actual.length; i += 96) {
    const a = actual.readInt16LE(i), b = expected.readInt16LE(i);
    dot += a * b; aa += a * a; bb += b * b;
  }
  return dot / Math.sqrt(aa * bb);
}

test('capture → serialized rows → finalization → playback → decoded tone across stop and restart', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-playback-chain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const encryption = {
    encryptBytes(bytes) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
    },
    decryptBytes(blob) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
      decipher.setAuthTag(blob.subarray(-16));
      return Buffer.concat([decipher.update(blob.subarray(12, -16)), decipher.final()]);
    },
  };
  const store = new MeetingAudioStore(root, { now: () => ORIGIN, encryption, codec: fakeCodec });
  const firstMic = tone(440), firstSystem = tone(660);
  const nextMic = tone(550), nextSystem = tone(880);
  store.begin(1, ORIGIN);
  store.append(1, 'mic', firstMic, ORIGIN);
  store.append(1, 'system', firstSystem, ORIGIN);
  store.finish(1);
  store.begin(1, ORIGIN + 600_000);
  store.append(1, 'mic', nextMic, ORIGIN + 600_000);
  store.append(1, 'system', nextSystem, ORIGIN + 600_000);
  store.finish(1);
  const status = store.status(1);
  const recordingId = status.recordingId;
  const capture = extendBatchCapture(extendBatchCapture({ start: null, end: null }, ORIGIN,
    2.5 * RATE * 2), ORIGIN + 2500, 2.5 * RATE * 2);
  assert.deepEqual(capture, { start: ORIGIN, end: ORIGIN + 5000 });
  const first = attachUndiarizedAudioSpans([
    { id: 'aligned-mic', source: 'mic', text: 'first mic', timestamp: ORIGIN + 4_000,
      speechStart: ORIGIN + 1_000, speechEnd: ORIGIN + 1_600, recordingId,
      recordingOrigin: ORIGIN, timebase: 'epoch', wordTimings: [{ word: 'first', start: 1, end: 1.3 },
        { word: 'mic', start: 1.3, end: 1.6 }] },
    { id: 'unaligned-system', source: 'system', text: 'first system', timestamp: ORIGIN + 8_000,
      speechStart: capture.start, speechEnd: capture.end, recordingId,
      recordingOrigin: ORIGIN, timebase: 'epoch' },
  ], status);
  assert.equal(first[0].audioSpan.recordingId, recordingId);
  const resumed = rebaseDiarizedRows([
    { id: 'resumed-system', source: 'system', text: 'second system', timestamp: 4,
      speechStart: ORIGIN + 601_000, speechEnd: ORIGIN + 601_600 },
    { id: 'resumed-mic', source: 'mic', text: 'second mic', timestamp: 4,
      speechStart: ORIGIN + 601_000, speechEnd: ORIGIN + 601_600 },
  ], { sessionOrigin: ORIGIN + 600_000, recordingOrigin: ORIGIN, recordingId });
  assert.equal(resumed[0].timestamp, 604);
  const { serializeTranscriptSegments } = await import('../../src/utils/transcriptSpeakerState.ts');
  const { playbackRange, PlaybackUnavailableError } = await import('../../src/utils/meetingAudioPlayback.ts');
  const rows = readTranscriptDocument(serializeTranscriptSegments([...first, ...resumed])).rows;
  for (const [id, expectedPcm, offset] of [
    ['aligned-mic', firstMic, 0], ['unaligned-system', firstSystem, 0],
    ['resumed-system', nextSystem, 600], ['resumed-mic', nextMic, 600],
  ]) {
    const row = rows.find(candidate => candidate.id === id);
    const range = playbackRange(row, rows, recordingId, status.startedAt, status.tracks);
    assert.equal(range.track, row.source);
    assert.ok(range.from <= offset + 1 && range.to >= offset + 1.6, `${id}: ${JSON.stringify(range)}`);
    const result = store.span(1, range.track, range.from, range.to);
    assert.equal(result.state, 'available', id);
    const from = Math.round((range.from - offset) * RATE);
    const expected = expectedPcm.subarray(from * 2, from * 2 + result.wav.length - 44);
    assert.ok(correlation(result.wav.subarray(44), expected) > .9, `${id} plays its labelled tone`);
  }
  const gap = { id: 'gap', source: 'system', timestamp: ORIGIN + 300_000,
    speechStart: ORIGIN + 299_000, speechEnd: ORIGIN + 300_000, recordingId,
    recordingOrigin: ORIGIN, timebase: 'epoch' };
  assert.throws(() => playbackRange(gap, [...rows, gap], recordingId, ORIGIN, status.tracks),
    error => error instanceof PlaybackUnavailableError && error.reason === 'gap');
  assert.equal(store.span(1, 'system', 300, 301).state, 'gap');
  const mic = rows.find(row => row.id === 'aligned-mic');
  assert.throws(() => playbackRange({ ...mic, audioSpan: { ...mic.audioSpan, trackId: 'system' } },
    rows, recordingId, ORIGIN, status.tracks),
  error => error instanceof PlaybackUnavailableError && error.reason === 'track');
  assert.throws(() => playbackRange({ ...resumed[0], recordingOrigin: ORIGIN + 600_000 },
    rows, recordingId, ORIGIN, status.tracks),
  error => error instanceof PlaybackUnavailableError && error.reason === 'timebase');
  const destination = path.join(root, 'calibration-system.wav');
  assert.equal(store.exportTrack(1, 'system', destination), 605);
  const fd = fs.openSync(destination, 'r');
  const silence = Buffer.alloc(4096);
  fs.readSync(fd, silence, 0, silence.length, 44 + 300 * RATE * 2);
  fs.closeSync(fd);
  assert.ok(silence.every(byte => byte === 0), 'export represents the stopped interval as silence');
  const { buildCalibrationLabels } = require('../../src/helpers/speakerCalibrationExport');
  const labels = buildCalibrationLabels({ transcript: serializeTranscriptSegments([...first, ...resumed, gap]) },
    { system: { file: 'calibration-system.wav', durationSeconds: 605 } }, status);
  assert.equal(labels.rows.find(row => row.rowId === 'resumed-system').start, 601);
  assert.equal(labels.rows.find(row => row.rowId === 'gap').unavailableReason, 'gap');
});
