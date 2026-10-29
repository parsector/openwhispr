const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
global.React = React;
const Picker = require("../../src/components/todos/TodoPersonPicker.tsx").default;

test("assignee suggestions filter live and keyboard selection uses a known person", async () => {
  const { Window } = await import("happy-dom");
  const browser = new Window();
  const previous = { window: global.window, document: global.document, navigator: global.navigator, IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT };
  global.window = browser; global.document = browser.document; global.navigator = browser.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const queries = []; const selected = [];
  browser.electronAPI = { getSpeakerProfiles: async () => [{ id: 1, display_name: "Alana", email: "alana@example.com" }], searchContacts: async (query) => {
    queries.push(query);
    return { success: true, contacts: [
      { email: "alice@example.com", display_name: "Alice" },
      { email: "alex@example.com", display_name: "Alex" },
    ].filter((person) => person.display_name.toLowerCase().includes(query.toLowerCase())) };
  } };
  const { createRoot } = require("react-dom/client");
  const host = browser.document.createElement("div"); browser.document.body.append(host);
  const root = createRoot(host);
  const Harness = () => { const [value, setValue] = React.useState(""); return React.createElement(Picker, { value, onChange: setValue, onSelect: (name) => selected.push(name), onCancel() {} }); };
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    assert.equal(host.querySelectorAll('[role="option"]').length, 3);
    const input = host.querySelector('input[role="combobox"]');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(input, "Al");
      input.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
    assert.equal(queries.at(-1), "Al");
    assert.equal(host.querySelectorAll('[role="option"]').length, 3);
    assert.equal(host.querySelector('[role="option"]').textContent.includes("Alana"), true, "saved speaker profiles precede contacts");
    await React.act(async () => input.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await React.act(async () => input.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    assert.deepEqual(selected, ["Alice"]);
  } finally {
    await React.act(async () => root.unmount()); browser.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete global[key]; else global[key] = value; }
  }
});
