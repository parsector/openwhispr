const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourceRoot = path.resolve(__dirname, '../../src');
function visit(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file, files);
    else if (/\.(?:js|jsx|ts|tsx)$/.test(entry.name)) files.push(file);
  }
  return files;
}

test('activation and remote analytics endpoints have no source call sites', () => {
  for (const file of visit(sourceRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\/api\/activation\//, file);
    assert.doesNotMatch(source, /\/api\/analytics\/(?:events|summary)/, file);
    const analyticsPaths = source.match(/\/api\/analytics\/[a-z-]+/g) || [];
    assert.deepEqual(analyticsPaths.filter((endpoint) => endpoint !== '/api/analytics/participation'), [], file);
    if (file.endsWith('LeaderboardService.ts')) {
      assert.doesNotMatch(source, /cloudPost(?:ForAuthGeneration)?/, file);
    }
  }
});
