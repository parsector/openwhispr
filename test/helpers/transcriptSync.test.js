const test = require("node:test");
const assert = require("node:assert/strict");
const { buildNoteCreatePayload, buildNoteUpdatePayload } = require("../../src/helpers/cloudSyncGuards");
const {
  readTranscriptDocument,
  writeTranscriptDocument,
  publicTranscript,
  reconcileCloudTranscript,
} = require("../../src/helpers/transcriptDocument");

test("vetoed identities stay private across sync, import, and re-export", () => {
  // An unrestricted note may compare every local contact, but rejection must
  // not disclose a previously unknown contact through its portable assignment.
  const rejected = {
    id: "row",
    text: "unclear words",
    source: "system",
    speaker: "speaker_0",
    speakerName: "Private contact",
    speakerDecision: {
      unrestricted: true,
      eligibleProfileIds: [7],
      acousticWinnerProfileId: 7,
      acceptedProfileId: null,
      acceptedIdentity: { email: "private@example.com" },
      rejectionReason: "not_sure",
    },
  };
  const assertPrivate = (raw) => {
    const row = readTranscriptDocument(raw).rows[0];
    assert.equal(raw.includes("private@example.com"), false);
    assert.equal(row.speakerName, undefined);
    assert.equal(row.speakerDecision, undefined);
    assert.deepEqual(row.speakerAssignment, { origin: "machine", accepted: false });
  };
  const transcript = writeTranscriptDocument([rejected]);
  for (const build of [buildNoteCreatePayload, buildNoteUpdatePayload]) {
    const payload = build({ transcript, participants: "[]" }, null);
    assertPrivate(payload.transcript);
    const imported = reconcileCloudTranscript(payload.transcript, null).transcript;
    assertPrivate(imported);
    assertPrivate(publicTranscript(imported));
  }

  // Older senders can still supply a rejected assignment containing an email.
  const legacy = writeTranscriptDocument([{
    id: "legacy",
    text: "hello",
    speakerName: "Private contact",
    speakerAssignment: { origin: "machine", accepted: false, email: "private@example.com" },
  }]);
  const imported = reconcileCloudTranscript(legacy, null).transcript;
  assertPrivate(imported);
  assertPrivate(publicTranscript(imported));
});

for (const participants of [
  null,
  "[]",
  "[ ]",
  "   ",
  "{broken",
  "null",
  "{}",
  '[{"email":"a@example.com"}]',
]) {
  test(`run8: text-only sync preserves local attribution until contextual installation (${JSON.stringify(participants)})`, () => {
    const {
      enforceTranscript,
      readScope,
      decision,
    } = require("../../src/helpers/noteSpeakerScope");
    const note = { id: 42, participants };
    const profile = { id: 1, email: "a@example.com" };
    const db = { getNote: () => note, getSpeakerProfiles: () => [profile] };
    const recorded = decision(readScope(db, note.id), { path: "test", profile });
    const rows = [
      { id: "r", text: "Hello", speakerName: "Alice", uncertainty: { reason: "close_match" } },
      { id: "human", text: "Hello", speakerName: "Chosen", speakerLockSource: "user" },
      {
        id: "recorded",
        text: "Hello",
        speakerIsPlaceholder: true,
        speakerDecision: { ...recorded, acceptedProfileId: null, rejectionReason: "no_match" },
      },
    ];
    const localRaw = writeTranscriptDocument(rows);
    const before = readTranscriptDocument(localRaw).rows;
    const merged = reconcileCloudTranscript(
      JSON.stringify(
        rows.map((row) => ({ id: row.id, text: "Edited", speakerName: "Cloud proposal" }))
      ),
      localRaw
    ).transcript;
    const mergedRows = readTranscriptDocument(merged).rows;
    assert.deepEqual(
      mergedRows,
      before.map((row) => ({ ...row, text: "Edited" })),
      "text-only reconciliation must not touch attribution"
    );
    const installed = readTranscriptDocument(
      enforceTranscript(db, note.id, merged, { path: "cloud_import", storedRows: before })
    ).rows;
    const unrestricted = participants == null || ["[]", "[ ]"].includes(participants);
    assert.equal(installed[0].speakerName, unrestricted ? "Alice" : undefined);
    if (!unrestricted) {
      assert.equal(installed[0].speakerReviewRequired, true);
      assert.equal(installed[0].speakerDecision.rejectionReason, "legacy_not_evaluated");
    }
    assert.equal(installed[1].speakerName, "Chosen");
    assert.equal(installed[1].speakerLockSource, "user");
    assert.deepEqual(installed[2].speakerDecision, before[2].speakerDecision);
  });
}
