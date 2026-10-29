const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "../../src/locales");
const locales = ["en", "ar", "es", "fr", "de", "pt", "it", "ru", "ja", "zh-CN", "zh-TW"];
const english = JSON.parse(fs.readFileSync(path.join(root, "en/translation.json"), "utf8")).todos;

test("all eleven locales contain the complete Todos namespace", () => {
  for (const locale of locales) {
    const value = JSON.parse(fs.readFileSync(path.join(root, locale, "translation.json"), "utf8")).todos;
    assert.deepEqual(Object.keys(english).filter((key) => !(key in value)), [], `${locale} lacks Todos keys`);
    for (const key of Object.keys(english)) assert.ok(value[key], `${locale} lacks todos.${key}`);
  }
  assert.ok(Object.keys(english).length > 30);
});
