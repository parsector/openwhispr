const test = require('node:test');
const assert = require('node:assert/strict');
const { matchReason, shortSpanReason, changedAfterFinalReason } = require('../../src/helpers/speakerUncertainty');

test('each reason requires its own evidence and never creates a percentage', () => {
  assert.equal(matchReason(null, null), null);
  assert.equal(matchReason({name:'Alex',score:.8}, null), null);
  assert.deepEqual(matchReason({name:'Alex',score:.70},{name:'Sam',score:.69}), {reason:'close_match',candidates:['Alex','Sam']});
  assert.deepEqual(matchReason({name:'Alex',score:.55}, null), {reason:'not_sure'});
  assert.equal(shortSpanReason(null), null);
  assert.equal(shortSpanReason({start:0,end:2}), null);
  assert.deepEqual(shortSpanReason({start:0,end:1.2}), {reason:'too_short'});
  assert.equal(changedAfterFinalReason('Alex','Alex'), null);
  assert.deepEqual(changedAfterFinalReason('Alex','Sam'), {reason:'changed_after_final'});
  for (const reason of [matchReason({name:'A',score:.55}, null), shortSpanReason({start:0,end:1}), changedAfterFinalReason('A','B')]) {
    assert.doesNotMatch(JSON.stringify(reason), /%|percent|confidence/);
  }
});
