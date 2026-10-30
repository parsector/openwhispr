const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('renderer has no direct speaker mapping write routes', () => {
  const root = path.join(__dirname, '../..');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const handlers = fs.readFileSync(path.join(root, 'src/helpers/ipcHandlers.js'), 'utf8');
  assert.equal(/setSpeakerMapping:|removeSpeakerMapping:/.test(preload), false);
  assert.equal(/ipcMain\.handle\([\s\S]{0,30}["'](?:set|remove)-speaker-mapping["']/.test(handlers), false);
});
