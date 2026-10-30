const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveSpeakerIdentifier } = require('../../src/helpers/liveSpeakerIdentifier');

test('a recording cache follows rename and merge, then drops deleted and cleared voice state', () => {
  const live = new LiveSpeakerIdentifier();
  live.running = true;
  live.transientEmbeddings.set('live_0', new Float32Array([1, 0]));
  live.transientCounts.set('live_0', 1);
  live.transientProfileIds.set('live_0', 10);
  live.transientDisplayNames.set('live_0', 'Alex');
  live.currentSegmentSpeakerId = 'live_0';
  live.currentSegmentSpeakerName = 'Alex';

  live.reconcilePeopleMutation({ type: 'rename', profileId: 10, displayName: 'Alec' });
  assert.equal(live.currentSegmentSpeakerName, 'Alec');
  live.reconcilePeopleMutation({ type: 'merge', profileId: 10, survivorId: 11, displayName: 'Sam' });
  assert.equal(live.transientProfileIds.get('live_0'), 11);
  assert.equal(live.currentSegmentSpeakerName, 'Sam');
  live.reconcilePeopleMutation({ type: 'undo_merge', profileId: 10, survivorId: 11, displayName: 'Alec' });
  assert.equal(live.transientProfileIds.get('live_0'), 10);
  assert.equal(live.currentSegmentSpeakerName, 'Alec');
  live.reconcilePeopleMutation({ type: 'merge', profileId: 10, survivorId: 11, displayName: 'Sam' });
  live.reconcilePeopleMutation({ type: 'delete', profileId: 11 });
  assert.equal(live.transientEmbeddings.has('live_0'), false);
  assert.equal(live.currentSegmentSpeakerId, null);
  assert.equal(live.currentSegmentSpeakerName, null);

  live.transientEmbeddings.set('live_1', new Float32Array([0, 1]));
  live.transientProfileIds.set('live_1', 12);
  live.currentSegmentSpeakerId = 'live_1';
  live.reconcilePeopleMutation({ type: 'clear_voice' });
  assert.equal(live.transientEmbeddings.size, 0);
  assert.equal(live.currentSegmentSpeakerId, null);
});
