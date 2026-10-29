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
const { useLocalApprovalStore } = require("../../src/stores/localApprovalStore.ts");

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
  assert.deepEqual(grouped.find((group) => group.key === "today").rows.map((item) => item.id), ["completed", "today-older", "today"], "archived rows interleave without changing the date order");
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

test("handoff is hidden without projects and a cancelled linked job keeps its todo open", async () => {
  const plain = renderToStaticMarkup(React.createElement(TodoRow, { row: row("no-project", null),
    onComplete() {}, onReject() {}, onDue() {}, onPerson() {}, onOpenNote() {}, projects: [] }));
  assert.doesNotMatch(plain, /todos\.sendToAgent/);
  const failed = renderToStaticMarkup(React.createElement(TodoRow, { row: { ...row("failed", null), agent_job_id: "job-failed" },
    jobStatus: "failed", onComplete() {}, onReject() {}, onDue() {}, onPerson() {}, onOpenNote() {}, projects: [] }));
  assert.match(failed, /title="todos.handoffFailed"/);
  assert.doesNotMatch(failed, /title="todos.openAgentJob"/);

  const { Window } = await import("happy-dom");
  const browser = new Window();
  const previous = { window: global.window, document: global.document, navigator: global.navigator,
    IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT };
  const priorStore = useTodosStore.getState();
  global.window = browser;
  global.document = browser.document;
  global.navigator = browser.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  let rows = [row("handoff", null)];
  let jobStatus = "pending";
  const prepared = [];
  const linked = [];
  const opened = [];
  browser.agentJobs = {
    projectsList: async () => ({ projects: [{ name: "Alpha" }, { name: "Beta" }] }),
    prepare: async (input) => { prepared.push(input); return { jobId: "job-123", prompt: input.task,
      harness: "claude", project: { name: input.project }, status: "pending" }; },
    get: async () => ({ status: jobStatus }),
    onUpdated: () => () => {},
    cancel: async () => { jobStatus = "cancelled"; },
  };
  browser.electronAPI = {
    isDebugEnabled: async () => false,
    commitmentsList: async () => rows,
    commitmentsProposalsList: async () => [],
    commitmentsOverdueCount: async () => 0,
    onCommitmentsUpdated: () => () => {},
    commitmentsSetAgentJob: async (id, jobId) => {
      linked.push([id, jobId]);
      rows = rows.map((item) => item.id === id ? { ...item, agent_job_id: jobId } : item);
      return rows[0];
    },
    getNotes: async () => [],
  };
  const { createRoot } = require("react-dom/client");
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(TodosView, { onOpenNote() {}, onOpenAgentJob(id) { opened.push(id); } })));
    const article = host.querySelector("article");
    const project = article.querySelector('select[aria-label="todos.agentProject"]');
    assert.equal(project.value, "Alpha");
    await React.act(async () => { project.value = "Beta"; project.dispatchEvent(new browser.Event("change", { bubbles: true })); });
    await React.act(async () => [...article.querySelectorAll("details button")].find((item) => item.textContent === "todos.sendToAgent").click());
    assert.deepEqual(prepared, [{ project: "Beta", task: "Send report handoff" }]);
    assert.deepEqual(linked, [["handoff", "job-123"]]);
    assert.equal(rows[0].status, "open");
    assert.ok(article.querySelector('button[title="todos.openAgentJob"]'));
    await React.act(async () => article.querySelector('button[title="todos.openAgentJob"]').click());
    assert.deepEqual(opened, ["job-123"]);
    assert.ok(article.querySelector('section[aria-label="agentJobs.card.title"]'));
    await React.act(async () => [...article.querySelectorAll("button")]
      .find((button) => button.textContent === "agentJobs.card.cancel").click());
    assert.equal(rows[0].status, "open");
    assert.ok(article.querySelector('span[title="todos.handoffCancelled"]'));
    assert.equal(article.querySelector('button[title="todos.openAgentJob"]'), null);
  } finally {
    await React.act(async () => root.unmount());
    useTodosStore.setState({ rows: priorStore.rows, proposals: priorStore.proposals,
      overdueCount: priorStore.overdueCount, showArchived: priorStore.showArchived, filter: priorStore.filter });
    useLocalApprovalStore.setState({ entries: {}, receipts: {} });
    browser.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
  }
});

test("completed todo shows a visible check and completion status", async () => {
  const i18n = i18next.createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: { todos: { completed: "Completed" } } } } });
  const html = renderToStaticMarkup(React.createElement(I18nextProvider, { i18n },
    React.createElement(TodoRow, { row: { ...row("done", null), status: "completed" },
      onComplete() {}, onReject() {}, onDue() {}, onPerson() {}, onOpenNote() {} })));
  const status = html.match(/<article[^>]*>\s*<button([^>]*)>(.*?)<\/button>/s);
  assert.ok(status);
  assert.match(status[1], /disabled=""/);
  assert.match(status[1], /aria-label="Completed"/);
  assert.match(status[1], /bg-primary\/10/);
  assert.match(status[1], /\btext-primary\b/);
  assert.doesNotMatch(status[1], /text-transparent|hover:/);
  assert.match(status[2], /data-icon="check"/);
  assert.match(html, />Completed<\/span>/);
});

test("rejected todo shows a visible X, status, and stored reason", async () => {
  const i18n = i18next.createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: { todos: { rejected: "Rejected" } } } } });
  const html = renderToStaticMarkup(React.createElement(I18nextProvider, { i18n },
    React.createElement(TodoRow, { row: { ...row("rejected", null), status: "rejected", rejected_reason: "Already handled" },
      onComplete() {}, onReject() {}, onDue() {}, onPerson() {}, onOpenNote() {} })));
  const status = html.match(/<article[^>]*>\s*<button([^>]*)>(.*?)<\/button>/s);
  assert.ok(status);
  assert.match(status[1], /disabled=""/);
  assert.match(status[1], /aria-label="Rejected"/);
  assert.match(status[1], /title="Already handled"/);
  assert.match(status[1], /bg-destructive\/10/);
  assert.match(status[1], /\btext-destructive\b/);
  assert.doesNotMatch(status[1], /text-transparent|hover:/);
  assert.match(status[2], /data-icon="x"/);
  assert.doesNotMatch(status[2], /data-icon="check"/);
  assert.match(html, />Rejected<\/span>/);
});

test("open todo keeps its empty idle circle and overdue accent", () => {
  const html = renderToStaticMarkup(React.createElement(TodoRow, { row: row("late", "2020-01-01"),
    onComplete() {}, onReject() {}, onDue() {}, onPerson() {}, onOpenNote() {} }));
  const status = html.match(/<article[^>]*>\s*<button([^>]*)>(.*?)<\/button>/s);
  assert.ok(status);
  assert.match(status[1], /aria-label="todos.complete"/);
  assert.doesNotMatch(status[1], /disabled=""/);
  assert.match(status[1], /text-transparent/);
  assert.ok(!status[1].match(/class="([^"]+)"/)[1].split(" ").includes("text-primary"));
  assert.doesNotMatch(status[1], /text-destructive/);
  assert.doesNotMatch(status[2], /data-icon=/);
  assert.match(html, /data-overdue="true"[^>]*before:bg-destructive/);
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
  const visibleActions = html.match(/<div data-todo-actions[^>]*>(.*?)<\/div>/)[1];
  assert.deepEqual([...visibleActions.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((match) => match[1]),
    ["todos.complete", "todos.reject"]);
  assert.match(html, /<summary[^>]*aria-label="todos.actions"/);
  assert.equal((html.match(/aria-label="todos.pickDate"/g) || []).length, 1,
    "the menu date input is the only date picker entry");
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
  browser.electronAPI = { isDebugEnabled: async () => false, commitmentsList: async () => rows, commitmentsProposalsList: async () => [],
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

test("Todo components do not use browser prompt, confirm, or alert dialogs", () => {
  const directory = path.join(__dirname, "../../src/components/todos");
  for (const filename of fs.readdirSync(directory)) {
    if (!/\.(tsx?|jsx?)$/.test(filename)) continue;
    const source = fs.readFileSync(path.join(directory, filename), "utf8");
    assert.doesNotMatch(source, /window\.(?:prompt|confirm|alert)\b/, filename);
  }
});

test("debug delete stays in the overflow menu until a second confirmation click, including archived rows", async () => {
  const props = { row: row("delete-me", null), onComplete() {}, onReject() {}, onDue() {},
    onPerson() {}, onOpenNote() {}, onDelete() {} };
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(TodoRow, { ...props, debugEnabled: false })), />todos\.delete<\/button>/);
  assert.match(renderToStaticMarkup(React.createElement(TodoRow, { ...props, row: { ...props.row, status: "completed" }, debugEnabled: true })), />todos\.delete<\/button>/);
  assert.match(renderToStaticMarkup(React.createElement(TodoRow, { ...props, row: { ...props.row, status: "rejected" }, debugEnabled: true })), />todos\.delete<\/button>/);

  const { Window } = await import("happy-dom");
  const browser = new Window();
  const previous = { window: global.window, document: global.document, navigator: global.navigator,
    IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT };
  global.window = browser;
  global.document = browser.document;
  global.navigator = browser.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = require("react-dom/client");
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  const deleted = [];
  const button = (label) => [...host.querySelectorAll("button")].find((item) => item.textContent === label);
  try {
    await React.act(async () => root.render(React.createElement(TodoRow, { ...props,
      debugEnabled: true, onDelete: (item) => deleted.push(item.id) })));
    await React.act(async () => button("todos.delete").click());
    assert.deepEqual(deleted, []);
    assert.ok(button("todos.deletePermanently"));
    assert.equal(button("todos.delete"), undefined, "menu content is replaced by confirmation");
    await React.act(async () => button("common.cancel").click());
    assert.deepEqual(deleted, []);
    assert.ok(button("todos.delete"));
    await React.act(async () => button("todos.delete").click());
    await React.act(async () => button("todos.deletePermanently").click());
    assert.deepEqual(deleted, ["delete-me"]);
  } finally {
    await React.act(async () => root.unmount());
    browser.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
  }
});

test("TodosView reads debug mode once and refreshes archived rows and counts after deletion", async () => {
  const { Window } = await import("happy-dom");
  const browser = new Window();
  const previous = { window: global.window, document: global.document, navigator: global.navigator,
    IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT };
  const priorStore = useTodosStore.getState();
  global.window = browser;
  global.document = browser.document;
  global.navigator = browser.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  let rows = [{ ...row("archived-test", null), status: "rejected" }, row("keep", null)];
  let flagReads = 0;
  let deleteCalls = 0;
  let updated;
  browser.electronAPI = {
    isDebugEnabled: async () => { flagReads++; return true; },
    commitmentsList: async () => rows,
    commitmentsProposalsList: async () => [],
    commitmentsOverdueCount: async () => rows.length,
    onCommitmentsUpdated: (callback) => { updated = callback; return () => {}; },
    commitmentsDelete: async (id) => { deleteCalls++; rows = rows.filter((item) => item.id !== id);
      updated(); return { success: true }; },
  };
  useTodosStore.setState({ showArchived: true, filter: null });
  const { createRoot } = require("react-dom/client");
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(TodosView, { onOpenNote() {} })));
    assert.equal(flagReads, 1);
    const target = [...host.querySelectorAll("article")].find((item) => item.textContent.includes("archived-test"));
    assert.ok(target);
    const menu = target.querySelector("details");
    const otherMenu = [...host.querySelectorAll("article")].find((item) => item !== target).querySelector("details");
    await React.act(async () => menu.querySelector("summary").click());
    assert.equal(menu.open, true);
    await React.act(async () => otherMenu.querySelector("summary").click());
    assert.equal(menu.open, false, "opening another row closes the first menu");
    assert.equal(otherMenu.open, true);
    await React.act(async () => menu.querySelector("summary").click());
    assert.equal(otherMenu.open, false);
    const button = (label) => [...menu.querySelectorAll("button")].find((item) => item.textContent === label);
    await React.act(async () => button("todos.delete").click());
    assert.equal(deleteCalls, 0);
    await React.act(async () => button("todos.deletePermanently").click());
    assert.equal(deleteCalls, 1);
    assert.doesNotMatch(host.textContent, /archived-test/);
    assert.match(host.textContent, /Send report keep/);
    assert.equal(useTodosStore.getState().overdueCount, 1);
  } finally {
    await React.act(async () => root.unmount());
    useTodosStore.setState({ rows: priorStore.rows, proposals: priorStore.proposals,
      overdueCount: priorStore.overdueCount, showArchived: priorStore.showArchived, filter: priorStore.filter });
    browser.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
  }
});

test("Reject actions share an inline reason form with confirm and cancel behavior", async () => {
  const { Window } = await import("happy-dom");
  const browser = new Window();
  const previous = { window: global.window, document: global.document, navigator: global.navigator,
    IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT };
  global.window = browser;
  global.document = browser.document;
  global.navigator = browser.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = require("react-dom/client");
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  const rejected = [];
  const button = (parent, label) => [...parent.querySelectorAll("button")].find((item) => item.textContent === label);
  const reasonInput = () => host.querySelector('input[placeholder="todos.rejectReason"]');
  try {
    await React.act(async () => root.render(React.createElement(TodoRow, { row: row("reject", null),
      onComplete() {}, onReject(item, reason) { rejected.push([item.id, reason]); },
      onDue() {}, onPerson() {}, onOpenNote() {} })));
    const actions = host.querySelector("[data-todo-actions]");
    await React.act(async () => button(actions, "todos.reject").click());
    assert.ok(reasonInput(), "the inline Reject action opens a reason field");
    await React.act(async () => {
      const input = reasonInput();
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(input, "No longer needed");
      input.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
    await React.act(async () => button(reasonInput().form, "todos.reject").click());
    assert.deepEqual(rejected, [["reject", "No longer needed"]]);
    assert.equal(reasonInput(), null, "the form closes after confirmation");

    const menu = host.querySelector("details");
    await React.act(async () => menu.querySelector("summary").click());
    await React.act(async () => button(menu, "todos.reject").click());
    assert.ok(reasonInput(), "the overflow Reject action opens the same form");
    assert.equal(menu.open, false);
    await React.act(async () => button(reasonInput().form, "todos.reject").click());
    assert.deepEqual(rejected, [["reject", "No longer needed"], ["reject", null]]);
    assert.equal(reasonInput(), null);

    await React.act(async () => button(actions, "todos.reject").click());
    await React.act(async () => {
      const input = reasonInput();
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(input, "Duplicate");
      input.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
    await React.act(async () => reasonInput().dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    assert.deepEqual(rejected, [["reject", "No longer needed"], ["reject", null], ["reject", "Duplicate"]]);
    assert.equal(reasonInput(), null, "Enter confirms and closes the form");

    await React.act(async () => button(actions, "todos.reject").click());
    await React.act(async () => reasonInput().dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(reasonInput(), null, "Escape closes the form");
    assert.equal(rejected.length, 3, "Escape does not reject");
    await React.act(async () => button(actions, "todos.reject").click());
    await React.act(async () => button(reasonInput().form, "common.cancel").click());
    assert.equal(reasonInput(), null, "Cancel closes the form");
    assert.equal(rejected.length, 3, "Cancel does not reject");
  } finally {
    await React.act(async () => root.unmount());
    browser.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
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
    isDebugEnabled: async () => false,
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
    const input = host.querySelector('textarea[aria-label="todos.addPlaceholder"]');
    assert.ok(input.form.classList.contains("ps-[37px]"));
    assert.ok(input.classList.contains("px-2"));
    assert.ok(input.classList.contains("rounded-md"));
    assert.ok(input.classList.contains("outline-none"));
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(input, "Send summary");
      input.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
    await React.act(async () => input.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    await React.act(async () => trigger.click());
    const reopened = host.querySelector('textarea[aria-label="todos.addPlaceholder"]');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(reopened, "Send summary");
      reopened.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
    await React.act(async () => {
      reopened.setSelectionRange(4, 4);
      reopened.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
      const value = reopened.value.slice(0, 4) + "\n" + reopened.value.slice(4);
      Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(reopened, value);
      reopened.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
    assert.equal(created.length, 0, "Shift+Enter keeps the composer open");
    await React.act(async () => reopened.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    assert.equal(created.length, 1);
    assert.equal(created[0].text, "Send\n summary");
  } finally {
    await React.act(async () => root.unmount());
    browser.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
  }
});

test("composer requests open and focus the draft once without replacing typed text", async () => {
  const { Window } = await import("happy-dom");
  const browser = new Window();
  const previous = { window: global.window, document: global.document, navigator: global.navigator,
    IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT };
  const previousRequest = useTodosStore.getState().composerRequestAt;
  global.window = browser;
  global.document = browser.document;
  global.navigator = browser.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  browser.electronAPI = { isDebugEnabled: async () => false, commitmentsList: async () => [], commitmentsProposalsList: async () => [],
    commitmentsOverdueCount: async () => 0, onCommitmentsUpdated: () => () => {} };
  const { createRoot } = require("react-dom/client");
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  const render = () => React.createElement(TodosView, { onOpenNote() {} });
  try {
    useTodosStore.setState({ composerRequestAt: previousRequest + 1 });
    await React.act(async () => root.render(render()));
    const input = host.querySelector('textarea[aria-label="todos.addPlaceholder"]');
    assert.ok(input, "the request opens the composer on initial mount");
    assert.equal(browser.document.activeElement, input);

    const trigger = host.querySelector('button[aria-expanded="true"]');
    trigger.focus();
    await React.act(async () => root.render(render()));
    assert.equal(browser.document.activeElement, trigger, "the same request does not steal focus again");

    await React.act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(input, "Keep this draft");
      input.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
    await React.act(async () => useTodosStore.setState({ composerRequestAt: previousRequest + 2 }));
    assert.equal(input.value, "Keep this draft");
    assert.equal(browser.document.activeElement, input);
  } finally {
    await React.act(async () => root.unmount());
    useTodosStore.setState({ composerRequestAt: previousRequest });
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

test("todos store requestComposer advances the request timestamp", () => {
  const previous = useTodosStore.getState().composerRequestAt;
  const originalNow = Date.now;
  try {
    Date.now = () => previous + 1000;
    useTodosStore.getState().requestComposer();
    assert.equal(useTodosStore.getState().composerRequestAt, previous + 1000);
  } finally {
    Date.now = originalNow;
    useTodosStore.setState({ composerRequestAt: previous });
  }
});

test("proposal banner keeps evidence and separate review actions", () => {
  const items = [{ id: "p1", note_id: "42", commitment_id: "c1",
    text: "Send the deck", quote: "I sent the deck", strength: "second_hand", expires_at: "2026-11-04" }];
  const html = renderToStaticMarkup(React.createElement(ProposalsBanner, { noteId: 42, items }));
  assert.match(html, /I sent the deck/);
  assert.match(html, /<button/g);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(ProposalsBanner, { noteId: 7, items })), /I sent the deck/);
});

test("todo menu has one native date input and no separate clear-date action", () => {
  const html = renderToStaticMarkup(React.createElement(TodoRow, { row: row("date", "2026-10-29"),
    onComplete() {}, onReject() {}, onDue() {}, onPerson() {}, onOpenNote() {} }));
  assert.doesNotMatch(html, /todos\.clearDate/);
  assert.equal((html.match(/<input[^>]*type="date"/g) || []).length, 1);
  assert.match(html, /<input dir="ltr" type="date"[^>]*value="2026-10-29"/);
  assert.doesNotMatch(html, /todo-calendar|role="grid"/);
  assert.match(html, /aria-label="todos.pickDate"/);
});

test("clearing the native date input sends the clear action", async () => {
  const { Window } = await import("happy-dom");
  const browser = new Window();
  const previous = { window: global.window, document: global.document, navigator: global.navigator,
    IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT };
  global.window = browser; global.document = browser.document; global.navigator = browser.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = require("react-dom/client");
  const host = browser.document.createElement("div"); browser.document.body.append(host);
  const root = createRoot(host);
  const due = [];
  try {
    await React.act(async () => root.render(React.createElement(TodoRow, { row: row("date", "2026-10-29"),
      onComplete() {}, onReject() {}, onDue(item, action) { due.push([item.id, action]); }, onPerson() {}, onOpenNote() {} })));
    await React.act(async () => host.querySelector("summary").click());
    const input = host.querySelector('input[type="date"]');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(input, "");
      input.dispatchEvent(new browser.Event("change", { bubbles: true }));
    });
    assert.deepEqual(due, [["date", { action: "clear" }]]);
    assert.equal(host.querySelector("details").open, false);
  } finally {
    await React.act(async () => root.unmount()); browser.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
  }
});

test("person editor saves typed Enter and contact choice, clears empty Enter, and cancels Escape", async () => {
  const { Window } = await import("happy-dom");
  const browser = new Window();
  const previous = { window: global.window, document: global.document, navigator: global.navigator,
    IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT };
  global.window = browser; global.document = browser.document; global.navigator = browser.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  browser.electronAPI = { getSpeakerProfiles: async () => [], searchContacts: async (query) => ({
    success: true, contacts: query.toLowerCase().includes("ali") ? [{ email: "alice@example.com", display_name: "Alice" }] : [],
  }) };
  const { createRoot } = require("react-dom/client");
  const host = browser.document.createElement("div"); browser.document.body.append(host);
  const root = createRoot(host);
  const people = [];
  const open = async () => {
    await React.act(async () => host.querySelector("summary").click());
    await React.act(async () => [...host.querySelectorAll("details button")].find((item) => item.textContent === "todos.editPerson").click());
    assert.equal(host.querySelector('input[role="combobox"]').form.querySelectorAll("button").length, 0);
  };
  const type = async (value) => {
    await React.act(async () => {
      const input = host.querySelector('input[role="combobox"]');
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
  };
  const key = async (value) => React.act(async () => host.querySelector('input[role="combobox"]')
    .dispatchEvent(new browser.KeyboardEvent("keydown", { key: value, bubbles: true })));
  try {
    await React.act(async () => root.render(React.createElement(TodoRow, { row: { ...row("person", null), person: "Original" },
      onComplete() {}, onReject() {}, onDue() {}, onPerson(item, person) { people.push([item.id, person]); }, onOpenNote() {} })));
    await open(); await type("Morgan"); await key("Enter");
    assert.deepEqual(people, [["person", "Morgan"]]);
    await open(); await type("Ali");
    await React.act(async () => host.querySelector('[role="option"]').click());
    assert.deepEqual(people.at(-1), ["person", "Alice"]);
    await open(); await type(""); await key("Enter");
    assert.deepEqual(people.at(-1), ["person", null]);
    await open(); await type("Cancelled"); await key("Escape");
    assert.equal(people.length, 3);
    assert.equal(host.querySelector('input[role="combobox"]'), null);
  } finally {
    await React.act(async () => root.unmount()); browser.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
  }
});

test("Edit todo focuses its textarea and saves the edited text through commitmentsUpdate", async () => {
  const { Window } = await import("happy-dom");
  const browser = new Window();
  const previous = { window: global.window, document: global.document, navigator: global.navigator,
    IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT };
  global.window = browser; global.document = browser.document; global.navigator = browser.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  let saved = row("edit", null);
  const updates = [];
  browser.electronAPI = {
    isDebugEnabled: async () => false,
    commitmentsList: async () => [saved], commitmentsProposalsList: async () => [], commitmentsOverdueCount: async () => 0,
    onCommitmentsUpdated: () => () => {},
    commitmentsUpdate: async (id, patch) => { updates.push([id, patch]); saved = { ...saved, ...patch, pinned_fields: '["text"]' }; return saved; },
  };
  const { createRoot } = require("react-dom/client");
  const host = browser.document.createElement("div"); browser.document.body.append(host);
  const root = createRoot(host);
  const priorStore = useTodosStore.getState();
  try {
    await React.act(async () => root.render(React.createElement(TodosView, { onOpenNote() {} })));
    const article = host.querySelector("article");
    await React.act(async () => [...article.querySelectorAll("details button")].find((button) => button.textContent === "todos.editText").click());
    const input = article.querySelector('textarea[aria-label="todos.editText"]');
    assert.equal(browser.document.activeElement, input);
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(input, "Edited [@Alex Ng](mention:alex%40example.com) report");
      input.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
    await React.act(async () => [...article.querySelectorAll("button")].find((button) => button.textContent === "todos.save").click());
    assert.deepEqual(updates, [["edit", { text: "Edited [@Alex Ng](mention:alex%40example.com) report" }]]);
    assert.equal(saved.text, "Edited [@Alex Ng](mention:alex%40example.com) report");
    assert.match(host.querySelector("article [data-todo-mention]").textContent, /@Alex Ng/);
    assert.doesNotMatch(host.querySelector("article").textContent, /mention:alex/);
  } finally {
    await React.act(async () => root.unmount());
    useTodosStore.setState({ rows: priorStore.rows, proposals: priorStore.proposals,
      overdueCount: priorStore.overdueCount, showArchived: priorStore.showArchived, filter: priorStore.filter });
    browser.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete global[key]; else global[key] = value; }
  }
});
