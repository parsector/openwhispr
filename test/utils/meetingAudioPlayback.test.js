const test = require('node:test');
const assert = require('node:assert/strict');

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
