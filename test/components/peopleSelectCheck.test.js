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

test('People headings use the Settings section header token at every level', () => {
  const people = fs.readFileSync(process.env.PEOPLE_HEADER_SOURCE || path.join(__dirname, '../../src/components/settings/PeoplePage.tsx'), 'utf8');
  const shared = fs.readFileSync(path.join(__dirname, '../../src/components/ui/SettingsSection.tsx'), 'utf8');
  assert.match(shared, /function SectionHeader\([\s\S]*?text-xs font-semibold text-foreground tracking-tight/);
  assert.match(shared, /function SectionHeader\([\s\S]*?className="mb-3"/);
  assert.match(people, /import \{ SectionHeader, SETTINGS_ROW_TITLE_CLASS \} from "\.\.\/ui\/SettingsSection"/);
  assert.match(shared, /SETTINGS_ROW_TITLE_CLASS = "text-xs font-medium text-foreground"/);
  assert.match(people, /\$\{SETTINGS_ROW_TITLE_CLASS\}/);
  assert.equal((people.match(/<SectionHeader\b/g) || []).length, 7);
  assert.doesNotMatch(people, /<h[1-6]\b/);
  assert.doesNotMatch(people, /t\("people\.noVoice"\)/);
});
