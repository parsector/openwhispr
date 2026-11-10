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
