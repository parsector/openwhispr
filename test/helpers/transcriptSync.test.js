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
