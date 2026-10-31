const test = require('node:test');
const assert = require('node:assert/strict');

test('transcript change notes and available restore come from the action log', async () => {
  const { projectSpeakerActions } = await import('../../src/utils/speakerActionProjection.ts');
  const row = { id: 'row-a', text: 'Hello', source: 'system', corrections: [{ id: 'stale' }] };
  const log = JSON.stringify({ version: 1, nextSequence: 3, actions: [
    { kind: 'correction', id: 'first', sequence: 1, event: {
      affectedRowIds: ['row-a'], initialAttribution: true,
      snapshots: { 'row-a': { previous: {}, next: { speakerName: 'Alex' } } } } },
    { kind: 'correction', id: 'second', sequence: 2, event: {
      affectedRowIds: ['row-a'], initialAttribution: false, afterFinalAnalysis: true,
      snapshots: { 'row-a': { previous: { speakerName: 'Alex' }, next: { speakerName: 'Sam' } } } } },
  ] });
  const [projected] = projectSpeakerActions([row], log);
  assert.deepEqual(projected.corrections.map(action => action.id), ['first', 'second']);
  assert.deepEqual(projected.corrections.map(action => action.undoAvailable), [false, true]);
  assert.equal(projected.changedAfterFinal, true);
  assert.equal(projectSpeakerActions([row], null)[0].corrections, undefined);
  const beforeFinal = JSON.stringify({ actions: [{ kind: 'correction', id: 'live-edit', sequence: 1,
    event: { actor: 'user', affectedRowIds: ['row-a'], initialAttribution: false } }] });
  assert.equal(projectSpeakerActions([row], beforeFinal)[0].changedAfterFinal, false);
});

test('older row-only action log entries project onto their row', async () => {
  const { projectSpeakerActions } = await import('../../src/utils/speakerActionProjection.ts');
  const rows = [{ id: 'row-a', text: 'Hello', source: 'system' }];
  const log = JSON.stringify({ actions: [{ kind: 'correction', id: 'old', sequence: 1,
    event: { rowId: 'row-a', actor: 'user', afterFinalAnalysis: true,
      snapshots: { 'row-a': { previous: { speakerName: 'Alex' }, next: { speakerName: 'Sam' } } } } }] });
  const [row] = projectSpeakerActions(rows, log);
  assert.deepEqual(row.corrections.map(action => action.id), ['old']);
  assert.equal(row.changedAfterFinal, true);
});

test('a permanently unavailable row action carries its reason instead of an ordering claim', async () => {
  const { projectSpeakerActions } = await import('../../src/utils/speakerActionProjection.ts');
  const rows = [{ id: 'row-a', text: 'Hello', source: 'system' }];
  const log = JSON.stringify({ actions: [{ kind: 'correction', id: 'blocked', sequence: 1,
    unavailableReason: 'history_quarantined', event: { affectedRowIds: ['row-a'] } }] });
  const [row] = projectSpeakerActions(rows, log);
  assert.equal(row.corrections[0].undoAvailable, false);
  assert.equal(row.corrections[0].unavailableReason, 'history_quarantined');
});
