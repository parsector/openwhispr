const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
global.React = React;
const { renderToStaticMarkup } = require("react-dom/server");
const i18next = require("i18next");
const { I18nextProvider } = require("react-i18next");
const { groupFor, groupTodos } = require("../../src/components/todos/TodoGroups.ts");
const TodoRow = require("../../src/components/todos/TodoRow.tsx").default;
const { boundedDateLabel } = require("../../src/components/todos/todoDateLabel.ts");
const TodosView = require("../../src/components/todos/TodosView.tsx").default;
const ProposalsBanner = require("../../src/components/todos/ProposalsBanner.tsx").default;
const { useTodosStore } = require("../../src/stores/todosStore.ts");
const { filterTodos } = require("../../src/components/todos/todoFilters.ts");

const row = (id, due_date, direction = "owe") => ({ id, text: `Send report ${id}`, status: "open",
  direction, due_date, created_at: "2026-10-28", person: null, quote: null,
  source_note_id: null, mention_count: 1, pinned_fields: "[]", source_removed: 0 });

test("groups overdue, today, upcoming, no-date and waiting in fixed order", () => {
  const now = new Date(2026, 9, 28, 10);
  const rows = [row("waiting", "2026-10-01", "waiting"), row("none", null),
    row("upcoming", "2026-11-01"), row("today", "2026-10-28"), row("late", "2026-10-27"),
    { ...row("today-older", "2026-10-28"), created_at: "2026-10-27" },
    { ...row("completed", "2026-10-26"), status: "completed" }];
  const grouped = groupTodos(rows, now);
  assert.deepEqual(grouped.map((group) => group.key), ["overdue", "today", "upcoming", "noDate", "waiting"]);
  assert.deepEqual(grouped.map((group) => [group.key, group.rows.map((item) => item.id)]), [
    ["overdue", ["late"]], ["today", ["completed", "today-older", "today"]], ["upcoming", ["upcoming"]],
    ["noDate", ["none"]], ["waiting", ["waiting"]],
  ]);
  const allRows = grouped.flatMap((group) => group.rows);
  assert.equal(allRows.length, rows.length);
  assert.deepEqual(allRows.map((item) => item.id).sort(), rows.map((item) => item.id).sort());
  for (const group of grouped) {
    for (const item of group.rows) assert.equal(groupFor(item, now), group.key);
  }
});

test("grouping drops empty groups and treats yesterday's open todo as overdue at midnight", () => {
  const midnight = new Date(2026, 9, 28, 0, 0);
  const noDate = row("none", null);
  assert.deepEqual(groupTodos([], midnight), []);
  assert.deepEqual(groupTodos([noDate], midnight), [{ key: "noDate", rows: [noDate] }]);
  assert.equal(groupFor(row("late", "2026-10-27"), midnight), "overdue");
  assert.equal(groupFor(row("today", "2026-10-28"), midnight), "today");
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

test("todo date pills use short local labels and a full accessible date", async () => {
  const OriginalDate = global.Date;
  const fixedNow = new OriginalDate(2026, 9, 28, 10);
  global.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [fixedNow.getTime()])); }
    static now() { return fixedNow.getTime(); }
  };
  const i18n = i18next.createInstance();
  const translations = Object.fromEntries(["en", "ar"].map((locale) => [locale, { translation: JSON.parse(
    fs.readFileSync(path.join(__dirname, `../../src/locales/${locale}/translation.json`), "utf8")) }]));
  await i18n.init({ lng: "en", fallbackLng: "en", resources: translations });
  const renderPill = (dueDate) => {
    const html = renderToStaticMarkup(React.createElement(I18nextProvider, { i18n },
      React.createElement(TodoRow, { row: row("date", dueDate),
        onComplete() {}, onReject() {}, onDue() {}, onPerson() {}, onOpenNote() {} })));
    const pill = html.match(/data-todo-date-column[^>]*><span([^>]*)>([^<]*)<\/span>/);
    assert.ok(pill, `date pill missing for ${dueDate}`);
    assert.doesNotMatch(pill[2], /^\d{4}-\d{2}-\d{2}$/);
    assert.ok([...pill[2]].length <= 12, `${dueDate}: ${pill[2]}`);
    const title = pill[1].match(/title="([^"]+)"/)?.[1];
    const ariaLabel = pill[1].match(/aria-label="([^"]+)"/)?.[1];
    assert.ok(title);
    assert.equal(ariaLabel, title);
    assert.ok(title.includes(new Intl.DateTimeFormat(i18n.language, { dateStyle: "full" })
      .format(new OriginalDate(`${dueDate}T12:00:00`))));
    return { html, label: pill[2], attributes: pill[1] };
  };
  try {
    const today = renderPill("2026-10-28");
    assert.equal(today.label, "Due today");
    assert.match(today.attributes, /Due today/);
    const tomorrow = renderPill("2026-10-29");
    assert.equal(tomorrow.label, "Tomorrow");
    assert.match(tomorrow.attributes, /Tomorrow/);
    assert.equal(renderPill("2026-10-31").label, "Sat 31");
    assert.equal(renderPill("2026-11-10").label, "10 Nov");
    assert.equal(renderPill("2027-10-31").label, "10/31");
    const overdue = renderPill("2026-10-27");
    assert.match(overdue.html, /data-overdue="true"[^>]*before:bg-destructive/);
    assert.match(overdue.attributes, /Overdue/);
    assert.match(overdue.attributes, /text-destructive/);
    await i18n.changeLanguage("ar");
    const arabic = renderPill("2027-10-31");
    assert.equal(arabic.label, new Intl.DateTimeFormat("ar", { day: "2-digit", month: "2-digit" }).format(new OriginalDate(2027, 9, 31)));
    assert.match(arabic.attributes, /أكتوبر/);
  } finally {
    global.Date = OriginalDate;
  }
});

test("semantic date labels bypass the composed-date limit but remain bounded", () => {
  assert.equal(boundedDateLabel("Due today", "10/28", "semantic"), "Due today");
  assert.equal(boundedDateLabel("Tomorrow", "10/29", "semantic"), "Tomorrow");
  assert.equal(boundedDateLabel("123456789012", "10/29", "semantic"), "123456789012");
  assert.equal(boundedDateLabel("1234567890123", "10/29", "semantic"), "10/29");
  assert.equal(boundedDateLabel("123456789", "10/31", "composed"), "10/31");
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

test("todo group headings have the same section top offset with and without overdue", async () => {
  const { Window } = await import("happy-dom");
  const browser = new Window();
  const previous = { window: global.window, document: global.document, navigator: global.navigator,
    IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT };
  const originalRows = useTodosStore.getState().rows;
  const rows = [row("late", "2020-01-01"), row("none", null), row("waiting", null, "waiting")];
  global.window = browser;
  global.document = browser.document;
  global.navigator = browser.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  browser.electronAPI = { commitmentsList: async () => rows, commitmentsProposalsList: async () => [],
    commitmentsOverdueCount: async () => 1, onCommitmentsUpdated: () => () => {} };
  const { createRoot } = require("react-dom/client");
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(TodosView, { onOpenNote() {} })));
    const sections = [...host.querySelectorAll("section[aria-labelledby]")];
    assert.equal(sections.length, 3);
    const offsets = sections.map((section) => {
      const heading = section.querySelector("h2");
      assert.equal(section.firstElementChild, heading);
      const topPadding = [...section.classList].filter((name) => name.startsWith("pt-"));
      assert.deepEqual(topPadding, ["pt-2.5"]);
      return Number(topPadding[0].slice(3)) * 4; // Tailwind spacing units are 4px.
    });
    assert.ok(Math.max(...offsets) - Math.min(...offsets) <= 0.5);
    const overdue = host.querySelector('section[aria-labelledby="overdue-heading"]');
    for (const className of ["-mx-[13px]", "px-[13px]", "bg-input"]) assert.ok(overdue.classList.contains(className));
    assert.ok(host.querySelector(".space-y-\\[26px\\]"));
  } finally {
    await React.act(async () => root.unmount());
    useTodosStore.setState({ rows: originalRows });
    browser.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
  }
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
