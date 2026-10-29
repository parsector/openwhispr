const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
global.React = React;
const { renderToStaticMarkup } = require("react-dom/server");
const i18next = require("i18next");
const { initReactI18next } = require("react-i18next");
const fs = require("node:fs");
const path = require("node:path");
const { buildPreMeetingBrief, matchesBriefPerson, parseBriefAttendees, personNames } = require("../../src/components/todos/preMeetingBriefModel.ts");
const PreMeetingBrief = require("../../src/components/todos/PreMeetingBrief.tsx").default;
const { MeetingNotificationCard } = require("../../src/components/MeetingNotificationCard.tsx");

const row = (id, person, direction = "owe", due_date = null) => ({ id, person, direction, due_date,
  text: `Task ${id}`, quote: `Quote ${id}`, status: "open", created_at: "2026-10-01" });

test("attendee names match full, first and email local part, including array people", () => {
  const attendee = { displayName: "Alice Smith", email: "asmith@example.com" };
  for (const person of ["alice smith", "ALICE", "asmith", '["Bob","Alice Smith"]'])
    assert.equal(matchesBriefPerson(person, attendee), true);
  assert.equal(matchesBriefPerson("Charlie", attendee), false);
  assert.deepEqual(personNames('["A","B"]'), ["a", "b"]);
  assert.deepEqual(parseBriefAttendees('[{"email":"a@example.com"},{"self":true}]').length, 1);
  assert.deepEqual(parseBriefAttendees("invalid"), []);
});

test("brief hides unmatched rows and sorts and caps both directions", () => {
  const rows = Array.from({ length: 7 }, (_, i) => row(String(i), "Alice", "owe", i === 0 ? "2026-10-01" : i === 1 ? "2026-11-01" : null));
  rows.push(row("wait", "Alice", "waiting", "2026-10-02"), row("other", "Bob"));
  rows.push({ ...row("done", "Alice"), status: "completed" }, { ...row("rejected", "Alice"), status: "rejected" });
  const brief = buildPreMeetingBrief([{ displayName: "Alice Smith" }], rows, new Date(2026, 9, 28));
  assert.equal(brief.length, 1);
  assert.equal(brief[0].owe.length, 5);
  assert.equal(brief[0].oweMore, 2);
  assert.equal(brief[0].owe[0].id, "0");
  assert.equal(brief[0].owe[1].id, "1");
  assert.equal(brief[0].waiting[0].id, "wait");
  assert.deepEqual(buildPreMeetingBrief([{ displayName: "Nobody" }], rows), []);
});

test("brief renders groups, due text and disclosure without an empty box", async () => {
  await i18next.use(initReactI18next).init({ lng: "en", resources: { en: { translation: JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")) } } });
  assert.equal(renderToStaticMarkup(React.createElement(PreMeetingBrief, { people: [], onComplete() {}, onMore() {} })), "");
  const people = buildPreMeetingBrief([{ displayName: "Alice" }], [row("one", "Alice")]);
  const html = renderToStaticMarkup(React.createElement(PreMeetingBrief, { people, onComplete() {}, onMore() {} }));
  assert.match(html, /You owe/);
  assert.match(html, /no date/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Quote one/);
  const capped = buildPreMeetingBrief([{ displayName: "Alice" }], Array.from({ length: 7 }, (_, i) => row(String(i), "Alice")));
  assert.match(renderToStaticMarkup(React.createElement(PreMeetingBrief, { people: capped, onComplete() {}, onMore() {} })), /\+2 more/);
  const cardProps = { title: "Planning", body: "Starts soon", startLabel: "Start" };
  assert.equal(renderToStaticMarkup(React.createElement(MeetingNotificationCard, cardProps)),
    renderToStaticMarkup(React.createElement(MeetingNotificationCard, { ...cardProps,
      prepCommitments: React.createElement(PreMeetingBrief, { people: [], onComplete() {}, onMore() {} }) })));
});
