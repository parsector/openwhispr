const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveSpeakerRoster,
  eligible,
  recordedNameAllowed,
  decisionCurrentForNote,
} = require("../../src/helpers/speakerRosterPolicy");
const profiles = [
  { id: 1, email: "a@example.com", display_name: "Alex" },
  { id: 2, email: "b@example.com", display_name: "Alex" },
  { id: 3, email: "c@example.com", display_name: "C" },
];
const ab = [{ email: " A@EXAMPLE.COM " }, { email: "b@example.com" }];
test("declared snapshots resolve exact unambiguous emails and never promote names or legacy links", () => {
  const note = {
    id: 42,
    participants: JSON.stringify([
      ...ab,
      { displayName: "C", profileId: 3 },
      { email: "unknown@example.com" },
    ]),
    calendar_event_id: "event",
  };
  const scope = resolveSpeakerRoster(
    note,
    { attendees: JSON.stringify([{ email: "c@example.com" }]) },
    profiles
  );
  assert.deepEqual(scope.eligibleProfileIds, [1, 2]);
  assert.equal(eligible(scope, 3), false);
  assert.equal(scope.source, "note");
  assert.equal(scope.rawRoster, note.participants);
  assert.deepEqual(scope.roster, JSON.parse(note.participants));
});
test("explicit empty never reads an event and absent participants only use the linked event", () => {
  assert.deepEqual(
    resolveSpeakerRoster(
      { id: 42, participants: "[]", calendar_event_id: "event" },
      { attendees: JSON.stringify(ab) },
      profiles
    ).eligibleProfileIds,
    [1, 2, 3]
  );
  assert.deepEqual(
    resolveSpeakerRoster(
      { id: 42, participants: null, calendar_event_id: "event" },
      { attendees: JSON.stringify(ab) },
      profiles
    ).eligibleProfileIds,
    [1, 2]
  );
  assert.deepEqual(
    resolveSpeakerRoster({ id: 42, participants: null }, null, profiles).eligibleProfileIds,
    [1, 2, 3]
  );
});
test("malformed JSON, missing context and unavailable linked-event data cannot become unrestricted", () => {
  for (const raw of ["null", "{}", "{broken", "[null]", '["a@example.com"]']) {
    const scope = resolveSpeakerRoster(
      { id: 42, participants: raw },
      { attendees: "[]" },
      profiles
    );
    assert.equal(scope.unrestricted, false);
    assert.deepEqual(scope.eligibleProfileIds, []);
  }
  assert.equal(resolveSpeakerRoster(null, null, profiles).unrestricted, false);
  assert.equal(
    resolveSpeakerRoster({ id: 42, calendar_event_id: "missing" }, null, profiles).unrestricted,
    false
  );
});
test("event roster excludes resources and declined non-self guests, retaining self", () => {
  const scope = resolveSpeakerRoster(
    { id: 42, calendar_event_id: "event" },
    {
      attendees: JSON.stringify([
        { email: "a@example.com", resource: true },
        { email: "b@example.com", responseStatus: "declined" },
        { email: "c@example.com", responseStatus: "declined", self: true },
      ]),
    },
    profiles
  );
  assert.deepEqual(scope.eligibleProfileIds, [3]);
});
test("scope snapshots do not follow mutation and revisions change on identity or roster edits", () => {
  const note = { id: 42, participants: [...ab] };
  const scope = resolveSpeakerRoster(note, null, profiles);
  note.participants.push({ email: "c@example.com" });
  assert.equal(scope.roster.length, 2);
  assert.equal(scope.rawRoster.length, 2);
  assert.notEqual(resolveSpeakerRoster(note, null, profiles).revision, scope.revision);
  assert.notEqual(
    resolveSpeakerRoster({ id: 42, participants: ab }, null, [
      ...profiles,
      { id: 4, email: "a@example.com" },
    ]).revision,
    scope.revision
  );
  assert.deepEqual(
    resolveSpeakerRoster({ id: 42, participants: ab }, null, [
      ...profiles,
      { id: 4, email: "a@example.com" },
    ]).eligibleProfileIds,
    [2]
  );
});
test("recorded veto defeats stale mappings while every human lock permits the owner decision", () => {
  const row = {
    speakerDecision: {
      acceptedProfileId: null,
      eligibleProfileIds: [1, 2],
      rejectionReason: "outside_roster",
    },
  };
  assert.equal(recordedNameAllowed(row), false);
  for (const lock of [
    { speakerLocked: true },
    { speakerLockSource: "user" },
    { speakerStatus: "locked" },
    { speakerStatus: "user_locked" },
  ])
    assert.equal(recordedNameAllowed({ ...row, ...lock }), true);
  assert.equal(recordedNameAllowed({ speakerName: "Historical" }), true);
});
test("renderer checks the generation and declared snapshot before accepting a delayed event", () => {
  const note = {
    id: 42,
    participants: JSON.stringify(ab),
    speaker_roster_revision: 3,
    calendar_event_id: "event",
  };
  const d = { ...resolveSpeakerRoster(note, null, profiles) };
  assert.equal(decisionCurrentForNote(d, note), true);
  assert.equal(decisionCurrentForNote(d, { ...note, speaker_roster_revision: 4 }), false);
  assert.equal(decisionCurrentForNote(d, { ...note, participants: "[]" }), false);
});

test("an unrelated library addition does not count as a roster revision", () => {
  for (const participants of [JSON.stringify(ab), "[]", null]) {
    const note = { id: 42, participants };
    assert.equal(
      resolveSpeakerRoster(note, null, [...profiles, { id: 4, email: "outsider@example.com" }])
        .revision,
      resolveSpeakerRoster(note, null, profiles).revision
    );
  }
});

test("an object without a note identity is missing context, not an unrestricted meeting", () => {
  assert.deepEqual(
    resolveSpeakerRoster({ participants: null }, null, profiles).eligibleProfileIds,
    []
  );
});
