const test = require('node:test');
const assert = require('node:assert/strict');
const { installBrowserGlobals } = require('../lib/rendererTestHarness');

test('participation refresh makes no request before explicit opt-in', async (t) => {
  const requests = [];
  installBrowserGlobals(t, {
    window: { electronAPI: { cloudApiRequest: async (request) => {
      requests.push(request);
      throw new Error('unexpected request');
    } } },
  });
  const { useLeaderboardParticipationStore } = require('../../src/stores/leaderboardParticipationStore.ts');
  useLeaderboardParticipationStore.getState().reset();
  await useLeaderboardParticipationStore.getState().refresh({ userId: 'private-account', authGeneration: 1 });
  assert.deepEqual(requests, []);
  assert.equal(useLeaderboardParticipationStore.getState().ready, true);
  assert.equal(useLeaderboardParticipationStore.getState().enabled, false);
});
