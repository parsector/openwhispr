const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const root = path.join(__dirname, '../../src/locales');
const english = JSON.parse(fs.readFileSync(path.join(root, 'en/translation.json'), 'utf8'));
function leaves(node, prefix = []) {
  return Object.entries(node).flatMap(([key, value]) =>
    typeof value === 'string' ? [[prefix.concat(key), value]] : leaves(value, prefix.concat(key)));
}
function at(node, keys) { return keys.reduce((value, key) => value?.[key], node); }
test('every routine string has non-English copy in the ten translated locales', () => {
  const keys = leaves(english).filter(([path]) => path.includes('routines'));
  for (const language of ['ar', 'de', 'es', 'fr', 'it', 'ja', 'pt', 'ru', 'zh-CN', 'zh-TW']) {
    const locale = JSON.parse(fs.readFileSync(path.join(root, language, 'translation.json'), 'utf8'));
    for (const [key, original] of keys) {
      const translated = at(locale, key);
      assert.equal(typeof translated, 'string', `${language}: ${key.join('.')} missing`);
      assert.notEqual(translated, original, `${language}: ${key.join('.')} still English`);
    }
  }
});
