const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
global.React = React;
const { renderToStaticMarkup } = require('react-dom/server');
const { Window } = require('happy-dom');
const TodoMentionInput = require('../../src/components/todos/TodoMentionInput.tsx').default;
const TodoRow = require('../../src/components/todos/TodoRow.tsx').default;
const { plainTodoText } = require('../../src/helpers/commitments/plainTodoText');
const { sourceChipsByIndex } = require('../../src/components/todos/sourceChips.ts');

const markdown = '[@Alex Ng](mention:alex%40example.com)';

test('mention entry inserts at caret, space ends trigger, and Escape leaves text alone', async () => {
  const browser = new Window();
  const old = { window: global.window, document: global.document, navigator: global.navigator, IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT };
  global.window = browser; global.document = browser.document; global.navigator = browser.navigator; global.IS_REACT_ACT_ENVIRONMENT = true;
  browser.electronAPI = { searchContacts: async () => ({ success: true, contacts: [{ display_name: 'Alex Ng', email: 'alex@example.com' }] }) };
  const host = browser.document.createElement('div'); browser.document.body.append(host);
  const { createRoot } = require('react-dom/client');
  const root = createRoot(host);
  const ref = React.createRef();
  function Harness() {
    const [value, setValue] = React.useState('Send  now');
    return React.createElement(TodoMentionInput, { value, onChange: setValue, inputRef: ref, label: 'Todo', onEscape() {}, onEnter() {}, className: '' });
  }
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    const input = host.querySelector('textarea');
    async function type(value, caret) {
      await React.act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value').set.call(input, value); input.setSelectionRange(caret, caret); input.dispatchEvent(new browser.Event('input', { bubbles: true })); input.dispatchEvent(new browser.Event('change', { bubbles: true })); });
    }
    await type('Send @ now', 6);
    await type('Send @Al now', 8);
    await React.act(async () => await Promise.resolve());
    assert.ok(host.querySelector('[role=listbox]'));
    await React.act(async () => input.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    assert.equal(input.value, `Send ${markdown} now`);
    await type(`Send ${markdown} more now`, `Send ${markdown} more`.length);
    assert.equal(host.querySelector('[role=listbox]'), null);
    await type(`Send ${markdown} more @`, input.value.length + 2);
    await React.act(async () => input.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(input.value, `Send ${markdown} more @`);
  } finally {
    await React.act(async () => root.unmount()); browser.close();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete global[key]; else global[key] = value; }
  }
});

test('saved todo renders a named avatar pill and plain-text surfaces show @Name', () => {
  const text = `Send ${markdown} the report`;
  const row = { id: '1', text, status: 'open', direction: 'owe', due_date: null, person: null, mention_count: 1, source_note_id: null, source_removed: 0 };
  const html = renderToStaticMarkup(React.createElement(TodoRow, { row, onComplete() {}, onReject() {}, onDue() {}, onPerson() {}, onOpenNote() {} }));
  assert.match(html, /data-todo-mention/);
  assert.match(html, /@Alex Ng/);
  assert.doesNotMatch(html, /mention:alex/);
  assert.equal(plainTodoText(text), 'Send @Alex Ng the report');
  assert.equal(sourceChipsByIndex([{ ...row, quote_segment_index: 0 }]).get(0)[0].text, 'Send @Alex Ng the report');
});
