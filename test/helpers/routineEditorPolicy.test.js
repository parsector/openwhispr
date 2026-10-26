const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceState, customTools, toggleSource, missingRequiredSelection, defaultSelection } = require('../../src/components/routines/editorPolicy.ts');

const notes = { id: 'notes', label: 'Notes', tools: ['search_notes', 'get_note'] };
const github = { id: 'github', label: 'GitHub', tools: ['github__search', 'github__read'] };

test('source chips project stored tools and preserve unrelated and custom tools', () => {
  const initial = ['search_notes', 'github__search', 'private_custom'];
  assert.equal(sourceState(notes, initial), 'partial');
  assert.deepEqual(customTools([notes, github], initial), ['private_custom']);
  const on = toggleSource(notes, initial);
  assert.equal(sourceState(notes, on), 'on');
  assert.deepEqual(toggleSource(notes, on), ['github__search', 'private_custom']);
  assert.equal(sourceState(github, on), 'partial');
  assert.deepEqual(toggleSource(github, on), ['search_notes', 'github__search', 'private_custom', 'get_note', 'github__read']);
});

test('source with no eligible tools stays disabled with a reason', () => {
  const disabled = { id: 'slack', label: 'Slack', tools: [], reason: 'needsApproval' };
  assert.equal(sourceState(disabled, []), 'disabled');
  assert.equal(disabled.reason, 'needsApproval');
  assert.deepEqual(toggleSource(disabled, ['search_notes']), ['search_notes']);
});

test('selection defaults to all and only empty required axes block a preset', () => {
  assert.deepEqual(defaultSelection(), { folder_ids: null, people: null, lookback_days: 7 });
  assert.deepEqual(missingRequiredSelection(defaultSelection(), ['folders', 'people']), { folders: false, people: false });
  assert.deepEqual(missingRequiredSelection({ folder_ids: [], people: [], lookback_days: 7 }, []), { folders: false, people: false });
  assert.deepEqual(missingRequiredSelection({ folder_ids: [], people: null, lookback_days: 7 }, ['folders', 'people']), { folders: true, people: false });
});

test('next three runs follow the local clock across a DST gap', () => {
  const { execFileSync } = require('node:child_process');
  const result = JSON.parse(execFileSync(process.execPath, ['-e', `
    const { nextThreeRuns } = require('./src/components/routines/editorPolicy.ts');
    const runs = nextThreeRuns([{ days: [0,1], time: '02:30' }], new Date(2026, 2, 8, 0, 0));
    process.stdout.write(JSON.stringify(runs.map((run) => run.toString())));
  `], { cwd: process.cwd(), env: { ...process.env, TZ: 'America/New_York', NODE_OPTIONS: '--import tsx' } }).toString());
  assert.equal(result.length, 3);
  assert.match(result[0], /Sun Mar 08 2026 03:30:00/);
  assert.match(result[1], /Mon Mar 09 2026 02:30:00/);
  assert.match(result[2], /Sun Mar 15 2026 02:30:00/);
});

test('development and build pre-hooks refresh the routine tool bundle', () => {
  const scripts = require('../../package.json').scripts;
  assert.match(scripts.predev, /compile:routine-tools/);
  assert.match(scripts.prebuild, /^npm run compile:routine-tools/);
  assert.doesNotMatch(scripts.prestart, /^npm run compile:routine-tools/);
});
