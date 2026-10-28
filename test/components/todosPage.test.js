const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
global.React = React;
const { renderToStaticMarkup } = require("react-dom/server");
const { groupTodos } = require("../../src/components/todos/TodoGroups.ts");
const TodoRow = require("../../src/components/todos/TodoRow.tsx").default;
const TodosView = require("../../src/components/todos/TodosView.tsx").default;
const ProposalsBanner = require("../../src/components/todos/ProposalsBanner.tsx").default;
const { useTodosStore } = require("../../src/stores/todosStore.ts");

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
});

test("todos view renders manual input and archive filter", () => {
  const html = renderToStaticMarkup(React.createElement(TodosView, { onOpenNote() {} }));
  assert.match(html, /type="checkbox"/);
  assert.match(html, /<form/);
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
