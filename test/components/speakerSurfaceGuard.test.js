const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../../src');
const surfaces = [
  'components/settings/PeoplePage.tsx',
  'components/notes/MeetingTranscriptChat.tsx',
];
const locales = ['en', 'ar', 'es', 'fr', 'de', 'pt', 'it', 'ru', 'ja', 'zh-CN', 'zh-TW'];
const valueAt = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);

test('speaker surfaces use tokens, shared selects, and keys present in all 11 locales', () => {
  const messages = Object.fromEntries(locales.map(locale => [locale,
    JSON.parse(fs.readFileSync(path.join(root, 'locales', locale, 'translation.json'), 'utf8'))]));
  for (const file of surfaces) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(/#[0-9a-f]{3,8}\b/i.test(source), false, `${file} has a hex literal`);
    assert.equal(/<(?:select|option)\b/.test(source), false, `${file} has a native select`);
    assert.equal(/\b(?:bg|text|border)-(?:amber|blue|green|red|yellow|orange|purple|pink|cyan)-/.test(source), false,
      `${file} has a palette color instead of a token`);
    for (const [, key] of source.matchAll(/\bt\(["']([^"']+)["']/g)) {
      if (key.includes('${') || key.endsWith('.')) continue;
      for (const locale of locales) assert.equal(typeof valueAt(messages[locale], key), 'string',
        `${file}: ${locale} is missing ${key}`);
    }
  }
});
