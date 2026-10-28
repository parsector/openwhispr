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
test('preexisting routine strings have non-English copy in the ten translated locales', () => {
  const keys = leaves(english).filter(([path]) => path.includes('routines') && !(path[0] === 'routines' && path[1] === 'editor'));
  assert.ok(keys.length >= 100, 'all 100 routine keys present on the parent stay covered');
  for (const language of ['ar', 'de', 'es', 'fr', 'it', 'ja', 'pt', 'ru', 'zh-CN', 'zh-TW']) {
    const locale = JSON.parse(fs.readFileSync(path.join(root, language, 'translation.json'), 'utf8'));
    for (const [key, original] of keys) {
      const translated = at(locale, key);
      assert.equal(typeof translated, 'string', `${language}: ${key.join('.')} missing`);
      assert.notEqual(translated, original, `${language}: ${key.join('.')} still English`);
    }
  }
});

test('editor v2 keys use the specified English values in every locale', () => {
  const newKeys = new Set(['titleTemplate', 'titleTemplateHelp', 'titlePreview']);
  const keys = leaves(english.routines.editor).filter(([key]) => !newKeys.has(key[0]));
  for (const language of ['ar', 'de', 'es', 'fr', 'it', 'ja', 'pt', 'ru', 'zh-CN', 'zh-TW']) {
    const locale = JSON.parse(fs.readFileSync(path.join(root, language, 'translation.json'), 'utf8'));
    for (const [key, original] of keys)
      assert.equal(at(locale.routines.editor, key), original, `${language}: routines.editor.${key.join('.')} differs from English`);
  }
});

test('title template editor strings are translated in every locale', () => {
  const keys = ['titleTemplate', 'titleTemplateHelp', 'titlePreview'];
  for (const language of ['ar', 'de', 'es', 'fr', 'it', 'ja', 'pt', 'ru', 'zh-CN', 'zh-TW']) {
    const locale = JSON.parse(fs.readFileSync(path.join(root, language, 'translation.json'), 'utf8'));
    for (const key of keys) {
      const translated = locale.routines.editor[key];
      assert.equal(typeof translated, 'string', `${language}: routines.editor.${key} missing`);
      assert.notEqual(translated, english.routines.editor[key], `${language}: routines.editor.${key} still English`);
    }
  }
});
