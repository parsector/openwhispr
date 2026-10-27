const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("./harness/db");
function input(db) {
  const folder = db.getFolders().find((f) => f.id === db.getMeetingsFolder().id);
  return {
    title: "Test meeting",
    folderId: folder.id,
    spaceId: folder.space_id,
    eventId: "event",
    participants: "[]",
  };
}
test("notification note creation atomically links metadata and reuses the owned calendar note", (t) => {
  const db = createDb(t);
  if (!db) return;
  const request = input(db);
  const first = db.createMeetingNoteForNotification(request);
  const second = db.createMeetingNoteForNotification(request);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.note.id, second.note.id);
  assert.equal(first.note.calendar_event_id, "event");
  assert.equal(db.getNotes().length, 1);
});
test("failed calendar metadata rolls the new note back, so retry creates just one note", (t) => {
  const db = createDb(t);
  if (!db) return;
  const original = db.updateNote;
  db.updateNote = () => ({ success: false });
  assert.throws(() => db.createMeetingNoteForNotification(input(db)), /metadata/i);
  assert.equal(db.getNotes().length, 0);
  db.updateNote = original;
  assert.equal(db.createMeetingNoteForNotification(input(db)).created, true);
  assert.equal(db.getNotes().length, 1);
});
test("strict calendar lookup throws but legacy lookup retains its null fallback", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.db.exec("DROP TABLE notes");
  assert.equal(db.getOwnNoteByCalendarEventId("event"), null);
  assert.throws(() => db.getOwnNoteByCalendarEventId("event", { throwOnError: true }));
});
test("another account owned note is never reused by a notification", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId("a");
  const first = db.createMeetingNoteForNotification(input(db));
  db.setActiveAccountId("b");
  const second = db.createMeetingNoteForNotification(input(db));
  assert.equal(second.created, true);
  assert.notEqual(first.note.id, second.note.id);
});

function insertEvent(db, id, summary, attendees) {
  db.db
    .prepare(
      "INSERT INTO calendar_events (id, calendar_id, summary, start_time, end_time, attendees) VALUES (?, 'calendar', ?, '2026-01-01', '2026-01-02', ?)"
    )
    .run(id, summary, JSON.stringify(attendees.map((email) => ({ email }))));
}

test("recurring notification inherits the latest matching title and attendee set", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertEvent(db, "first", " Weekly   Review ", ["A@EXAMPLE.COM", "b@example.com"]);
  insertEvent(db, "next", "weekly review", ["b@example.com", "a@example.com"]);
  const first = db.createMeetingNoteForNotification({ ...input(db), eventId: "first" }).note;
  db.updateNote(first.id, { enhancement_template_id: "custom-template" });
  const next = db.createMeetingNoteForNotification({ ...input(db), eventId: "next" }).note;
  assert.equal(next.enhancement_template_id, "custom-template");
});

test("recurring notification rejects a different attendee set and deleted notes", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertEvent(db, "first", "Review", ["a@example.com"]);
  insertEvent(db, "different", "Review", ["a@example.com", "b@example.com"]);
  insertEvent(db, "after-delete", "Review", ["a@example.com"]);
  const first = db.createMeetingNoteForNotification({ ...input(db), eventId: "first" }).note;
  db.updateNote(first.id, { enhancement_template_id: "custom-template" });
  assert.equal(
    db.createMeetingNoteForNotification({ ...input(db), eventId: "different" }).note
      .enhancement_template_id,
    null
  );
  db.db.prepare("UPDATE notes SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(first.id);
  assert.equal(
    db.createMeetingNoteForNotification({ ...input(db), eventId: "after-delete" }).note
      .enhancement_template_id,
    null
  );
});

test("a recurring lookup error leaves notification creation intact", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.db.exec("DROP TABLE calendar_events");
  const created = db.createMeetingNoteForNotification({ ...input(db), eventId: "missing" });
  assert.equal(created.created, true);
  assert.equal(created.note.enhancement_template_id, null);
});
