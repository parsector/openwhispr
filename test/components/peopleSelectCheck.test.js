const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('People and Review selects use the same shared control as microphone preferences', () => {
  const people = fs.readFileSync(path.join(__dirname, '../../src/components/settings/PeoplePage.tsx'), 'utf8');
  const microphone = fs.readFileSync(path.join(__dirname, '../../src/components/ui/MicrophoneSettings.tsx'), 'utf8');
  assert.match(microphone, /from ["']\.\/select["']/);
  assert.match(people, /from ["']\.\.\/ui\/select["']/);
  assert.doesNotMatch(people, /<select\b/);
  assert.equal((people.match(/<SelectTrigger\b/g) || []).length, 4);
  assert.match(people, /aria-label=\{t\("people\.sort"\)\} className="w-auto"/);
  const shared = fs.readFileSync(path.join(__dirname, '../../src/components/ui/select.tsx'), 'utf8');
  assert.match(shared, /gap-3\.5.*px-3\.5/);
  assert.match(shared, /<ChevronDown className="[^"]*shrink-0/);
});
