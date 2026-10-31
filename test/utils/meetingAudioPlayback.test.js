const test = require('node:test');
const assert = require('node:assert/strict');

test('playback ends before the next adjacent speaker on aligned and approximate rows', async () => {
  const { playbackRange } = await import('../../src/utils/meetingAudioPlayback.ts');
  const rows = [
    { id: 'a', source: 'system', timestamp: 1, text: 'hello there', wordTimings: [
      { word: 'hello', start: 1, end: 1.25 }, { word: 'there', start: 1.3, end: 1.6 }],
      audioSpan: { recordingId: 'meeting', trackId: 'system', startSample: 24000, endSample: 38400 } },
    { id: 'b', source: 'system', timestamp: 1.65, text: 'yes', wordTimings: [
      { word: 'yes', start: 1.65, end: 1.9 }],
      audioSpan: { recordingId: 'meeting', trackId: 'system', startSample: 39600, endSample: 45600 } },
  ];
  assert.deepEqual(playbackRange(rows[0], rows, 'meeting'),
    { from: 0.96, to: 1.64, track: 'system', approximate: false });
  assert.deepEqual(playbackRange({ ...rows[0], wordTimings: undefined, audioSpan: undefined }, rows, 'meeting'),
    { from: 0.96, to: 1.65, track: 'system', approximate: true });
  const overlappingNext = { ...rows[1], timestamp: .98,
    wordTimings: [{ word: 'yes', start: .98, end: 1.2 }],
    audioSpan: { ...rows[1].audioSpan, startSample: 23520, endSample: 28800 } };
  assert.equal(playbackRange(rows[0], [rows[0], overlappingNext], 'meeting').to, .98);
});

test('audio deletion revokes plaintext URLs, pauses players and rejects stale responses', async () => {
  const { MeetingAudioPlayback } = await import('../../src/utils/meetingAudioPlayback.ts');
  const revoked = [];
  const lease = new MeetingAudioPlayback(url => revoked.push(url));
  const player = { pauses: 0, pause() { this.pauses++; } };
  const pending = lease.request();
  assert.equal(lease.install(pending, 'blob:first', player), true);
  lease.invalidate();
  assert.equal(player.pauses, 1);
  assert.deepEqual(revoked, ['blob:first']);
  const stale = { pauses: 0, pause() { this.pauses++; } };
  assert.equal(lease.install(pending, 'blob:stale', stale), false);
  assert.equal(stale.pauses, 1);
  assert.deepEqual(revoked, ['blob:first', 'blob:stale']);
});
