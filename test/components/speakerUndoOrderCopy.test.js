const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('history and locked transcript rows explain newest-first undo', () => {
  const root = path.join(__dirname, '../../src');
  const people = fs.readFileSync(path.join(root, 'components/settings/PeoplePage.tsx'), 'utf8');
  const row = fs.readFileSync(path.join(root, 'components/notes/MeetingTranscriptChat.tsx'), 'utf8');
  const en = JSON.parse(fs.readFileSync(path.join(root, 'locales/en/translation.json'), 'utf8'));
  assert.match(people, /t\("people\.undoOrder"\)/);
  assert.match(people, /index !== newestActionIndex[^\n]*opacity-60/);
  assert.match(row, /rowAction && !rowAction\.undoAvailable/);
  assert.match(row, /t\("people\.undoOrder"\)/);
  assert.match(en.people.undoOrder, /newest first.*older entries unlock/i);
});
