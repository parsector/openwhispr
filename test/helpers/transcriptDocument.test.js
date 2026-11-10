const test = require("node:test");
const assert = require("node:assert/strict");
const {
  publicTranscript,
  readTranscriptDocument,
  writeTranscriptDocument,
} = require("../../src/helpers/transcriptDocument");

test("public serialization cannot resurrect a veto through a legacy mapping", () => {
  const row = {
    id: "row",
    text: "hello",
    speaker: "speaker_0",
    speakerIsPlaceholder: true,
    speakerDecision: {
      acceptedProfileId: null,
      eligibleProfileIds: [1],
      rejectionReason: "outside_roster",
    },
  };
  const exported = readTranscriptDocument(
    publicTranscript(writeTranscriptDocument([row]), { speaker_0: "Outsider C" })
  ).rows[0];
  assert.equal(exported.speakerName, undefined);
  assert.equal(exported.speakerIsPlaceholder, true);
});

test("public serialization discloses identity only for accepted visibly named rows", () => {
  for (const row of [
    {
      speakerName: "Private contact",
      speakerDecision: {
        acceptedProfileId: null,
        acceptedIdentity: { email: "private@example.com" },
        eligibleProfileIds: [7],
        rejectionReason: "not_sure",
      },
    },
    {
      speakerIsPlaceholder: true,
      speakerDecision: {
        acceptedProfileId: 7,
        acceptedIdentity: { email: "private@example.com" },
        eligibleProfileIds: [7],
        rejectionReason: null,
      },
    },
    {
      speakerName: "Private contact",
      speakerAssignment: { origin: "machine", accepted: false, email: "private@example.com" },
    },
  ]) {
    const serialized = publicTranscript(writeTranscriptDocument([{ id: "row", text: "hello", ...row }]));
    const exported = readTranscriptDocument(serialized).rows[0];
    assert.equal(serialized.includes("private@example.com"), false);
    assert.equal(exported.speakerName, undefined);
    assert.deepEqual(exported.speakerAssignment, { origin: "machine", accepted: false });
  }
});

test("public serialization respects every human lock, including explicit Unknown", () => {
  for (const lock of [
    { speakerLocked: true },
    { speakerLockSource: "user" },
    { speakerStatus: "locked" },
    { speakerStatus: "user_locked" },
  ]) {
    for (const name of ["Human C", undefined]) {
      const row = {
        id: "row",
        text: "hello",
        speaker: "speaker_0",
        speakerName: name,
        speakerIsPlaceholder: !name,
        ...lock,
      };
      const exported = readTranscriptDocument(
        publicTranscript(writeTranscriptDocument([row]), { speaker_0: "Wrong mapping" })
      ).rows[0];
      assert.equal(exported.speakerName, name);
    }
  }
});
