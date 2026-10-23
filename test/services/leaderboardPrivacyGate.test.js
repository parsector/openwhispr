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

test('a failed leave does not restart participation reads', async (t) => {
  const requests = [];
  installBrowserGlobals(t, {
    window: { electronAPI: { cloudApiRequest: async (request) => {
      requests.push(request);
      throw new Error('unexpected request');
    } } },
  });
  t.mock.method(console, 'error', () => {});
  const { LeaderboardService } = require('../../src/services/LeaderboardService.ts');
  t.mock.method(LeaderboardService, 'leaveParticipation', async () => {
    throw new Error('offline');
  });
  const { useLeaderboardParticipationStore } = require('../../src/stores/leaderboardParticipationStore.ts');
  const context = { userId: 'leaving-account', authGeneration: 1 };
  localStorage.setItem('leaderboardParticipation:leaving-account', 'true');
  useLeaderboardParticipationStore.getState().reset();
  assert.equal(await useLeaderboardParticipationStore.getState().leave(context), false);
  await useLeaderboardParticipationStore.getState().refresh(context);
  assert.deepEqual(requests, []);
  assert.equal(localStorage.getItem('leaderboardParticipation:leaving-account'), null);
});
