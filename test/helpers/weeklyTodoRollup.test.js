const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PRESETS } = require("../../src/helpers/routines/routinePresets");

test("weekly todo rollup is offered with the three existing presets", () => {
  assert.deepEqual(PRESETS.map((preset) => preset.id), [
    "morning-brief", "meeting-prep", "friday-digest", "weekly-todo-rollup",
  ]);
  const preset = PRESETS.find((item) => item.id === "weekly-todo-rollup");
  assert.deepEqual(preset.trigger_config.slots, [{ days: [5], time: "16:00" }]);
  assert.deepEqual(preset.suggested_tools, ["list_todos", "get_todo", "search_notes"]);
  const sections = ["What closed this week", "What is overdue right now", "What I am waiting on from others", "suggested focus for next week"];
  let previous = -1;
  for (const section of sections) {
    const index = preset.prompt.indexOf(section);
    assert.ok(index > previous, `${section} is present in order`);
    previous = index;
  }
  assert.match(preset.prompt, /rejection reasons/);
  assert.match(preset.prompt, /Cite meeting titles/);
  assert.match(preset.prompt, /exactly NOTHING_TO_REPORT/);
});

test("weekly todo rollup translation keys exist in all real locales", () => {
  for (const locale of ["ar", "de", "en", "es", "fr", "it", "ja", "pt", "ru", "zh-CN", "zh-TW"]) {
    const json = JSON.parse(fs.readFileSync(path.join(__dirname, "../../src/locales", locale, "translation.json")));
    assert.ok(json.routines.presets.weeklyTodoRollup.name, `${locale} name`);
    assert.ok(json.routines.presets.weeklyTodoRollup.description, `${locale} description`);
  }
});
