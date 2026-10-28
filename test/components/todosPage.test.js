const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
global.React = React;
const { renderToStaticMarkup } = require("react-dom/server");
const { groupTodos } = require("../../src/components/todos/TodoGroups.ts");
const TodoRow = require("../../src/components/todos/TodoRow.tsx").default;
const TodosView = require("../../src/components/todos/TodosView.tsx").default;
const ProposalsBanner = require("../../src/components/todos/ProposalsBanner.tsx").default;
const { useTodosStore } = require("../../src/stores/todosStore.ts");
const { filterTodos } = require("../../src/components/todos/todoFilters.ts");

const row = (id, due_date, direction = "owe") => ({ id, text: `Send report ${id}`, status: "open",
  direction, due_date, created_at: "2026-10-28", person: null, quote: null,
  source_note_id: null, mention_count: 1, pinned_fields: "[]", source_removed: 0 });

test("groups overdue, today, upcoming, no-date and waiting in fixed order", () => {
  const grouped = groupTodos([row("waiting", "2026-10-01", "waiting"), row("none", null),
    row("upcoming", "2026-11-01"), row("today", "2026-10-28"), row("late", "2026-10-27")],
  new Date(2026, 9, 28, 10));
  assert.deepEqual(grouped.map((group) => group.key), ["overdue", "today", "upcoming", "noDate", "waiting"]);
});

test("todo row renders status, date and hidden quote disclosure", () => {
  const html = renderToStaticMarkup(React.createElement(TodoRow, { row: { ...row("1", null), quote: "I will send the report" },
    onComplete() {}, onReject() {}, onDue() {}, onPerson() {}, onOpenNote() {} }));
  assert.match(html, /Send report 1/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /<blockquote/);
  assert.match(html, /data-todo-date-column/);
  assert.match(html, /w-\[76px\]/);
});

test("every todo date state keeps the fixed right-hand column", () => {
  for (const dueDate of ["2020-01-01", "2026-11-01", null]) {
    const html = renderToStaticMarkup(React.createElement(TodoRow, { row: row(`date-${dueDate}`, dueDate),
      onComplete() {}, onReject() {}, onDue() {}, onPerson() {}, onOpenNote() {} }));
    assert.match(html, /data-todo-date-column/);
    assert.match(html, /w-\[76px\] justify-end/);
  }
});

test("row actions reveal on hover and keyboard focus, with no visible links at rest", () => {
  const html = renderToStaticMarkup(React.createElement(TodoRow, { row: row("1", null),
    onComplete() {}, onReject() {}, onDue() {}, onPerson() {}, onOpenNote() {} }));
  const actions = html.match(/<div data-todo-actions(?:="[^"]*")? class="([^"]+)"/)[1];
  assert.match(actions, /opacity-0/);
  assert.match(actions, /group-hover:opacity-100/);
  assert.match(actions, /group-focus-within:opacity-100/);
  assert.match(actions, /duration-\[120ms\]/);
  assert.match(actions, /motion-reduce:transition-none/);
});

test("only overdue rows receive the inset destructive accent", () => {
  const render = (due_date) => renderToStaticMarkup(React.createElement(TodoRow, {
    row: row("1", due_date), onComplete() {}, onReject() {}, onDue() {}, onPerson() {}, onOpenNote() {},
  }));
  assert.match(render("2020-01-01"), /data-overdue="true"[^>]*before:bg-destructive/);
  assert.doesNotMatch(render(null), /data-overdue|before:bg-destructive/);
});

test("only agent-created todos show the client attribution badge", () => {
  const render = (source, source_agent) => renderToStaticMarkup(React.createElement(TodoRow, {
    row: { ...row("1", null), source, source_agent }, onComplete() {}, onReject() {}, onDue() {}, onPerson() {}, onOpenNote() {},
  }));
  assert.match(render("agent", "Claude Desktop"), /Claude Desktop/);
  assert.doesNotMatch(render("manual", "Claude Desktop"), /Claude Desktop/);
  assert.doesNotMatch(render("meeting", "Claude Desktop"), /Claude Desktop/);
});

test("todos view renders manual input and archive filter", () => {
  const html = renderToStaticMarkup(React.createElement(TodosView, { onOpenNote() {} }));
  assert.match(html, /type="checkbox"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /shadow-\[0_3px_13px/);
});

test("Todo components contain no literal hex colors", () => {
  for (const filename of ["todos/TodosView.tsx", "todos/TodoRow.tsx", "todos/TodoGroups.ts", "todos/ProposalsBanner.tsx", "MeetingNotificationOverlay.tsx", "ControlPanelSidebar.tsx"]) {
    const source = fs.readFileSync(path.join(__dirname, "../../src/components", filename), "utf8");
    assert.doesNotMatch(source, /#[\da-fA-F]{3,8}\b/, filename);
  }
});

test("composer opens, saves with Enter, and closes with Escape", async () => {
  const { Window } = await import("happy-dom");
  const browser = new Window();
  const previous = { window: global.window, document: global.document, navigator: global.navigator,
    requestAnimationFrame: global.requestAnimationFrame, IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT };
  global.window = browser;
  global.document = browser.document;
  global.navigator = browser.navigator;
  global.requestAnimationFrame = (callback) => callback();
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const created = [];
  browser.electronAPI = {
    commitmentsList: async () => [], commitmentsProposalsList: async () => [], commitmentsOverdueCount: async () => 0,
    onCommitmentsUpdated: () => () => {}, commitmentsCreate: async (input) => { created.push(input); return row("created", null); },
  };
  const { createRoot } = require("react-dom/client");
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(TodosView, { onOpenNote() {} })));
    const trigger = host.querySelector('button[aria-expanded="false"]');
    await React.act(async () => trigger.click());
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    const input = host.querySelector('input[aria-label="todos.addPlaceholder"]');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(input, "Send summary");
      input.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
    await React.act(async () => input.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    await React.act(async () => trigger.click());
    const reopened = host.querySelector('input[aria-label="todos.addPlaceholder"]');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(reopened, "Send summary");
      reopened.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
    await React.act(async () => reopened.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    assert.equal(created.length, 1);
    assert.equal(created[0].text, "Send summary");
  } finally {
    await React.act(async () => root.unmount());
    browser.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
  }
});

test("Todos person filter includes the attendee email alias", () => {
  const rows = [{ ...row("alice", null), person: "asmith", source_note_id: "42" },
    { ...row("bob", null), person: "Bob", source_note_id: "24" }];
  assert.deepEqual(filterTodos(rows, { kind: "person", value: "Alice Smith", email: "asmith@example.com" }).map((item) => item.id), ["alice"]);
  assert.deepEqual(filterTodos(rows, { kind: "note", value: "24" }).map((item) => item.id), ["bob"]);
  assert.equal(filterTodos(rows, null), rows);
});

test("todos store refreshes list, proposals and overdue badge", async () => {
  global.window = { electronAPI: { commitmentsList: async () => [row("a", null)],
    commitmentsProposalsList: async () => [], commitmentsOverdueCount: async () => 2 } };
  await useTodosStore.getState().refresh();
  assert.equal(useTodosStore.getState().rows.length, 1);
  assert.equal(useTodosStore.getState().overdueCount, 2);
  delete global.window;
});

test("proposal banner keeps evidence and separate review actions", () => {
  const items = [{ id: "p1", note_id: "42", commitment_id: "c1",
    text: "Send the deck", quote: "I sent the deck", strength: "second_hand", expires_at: "2026-11-04" }];
  const html = renderToStaticMarkup(React.createElement(ProposalsBanner, { noteId: 42, items }));
  assert.match(html, /I sent the deck/);
  assert.match(html, /<button/g);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(ProposalsBanner, { noteId: 7, items })), /I sent the deck/);
});
