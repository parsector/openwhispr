const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeTranscriptSegments } = require("../../src/utils/transcriptSpeakerState.ts");
for (const lock of [
  null,
  { speakerLocked: true },
  { speakerLockSource: "user" },
  { speakerStatus: "locked" },
  { speakerStatus: "user_locked" },
]) {
  test(`renderer final respects ${JSON.stringify(lock) || "machine veto"}`, () => {
    const row = {
      id: "r",
      text: "hello",
      source: "system",
      speakerName: lock ? "Manual outsider" : undefined,
      speakerIsPlaceholder: !lock,
      ...lock,
      speakerDecision: {
        decisionId: "veto",
        eligibleProfileIds: [1],
        acceptedProfileId: null,
        rejectionReason: "no_match",
      },
    };
    const incoming = {
      ...row,
      speakerName: "A",
      speakerIsPlaceholder: false,
      speakerLocked: false,
      speakerLockSource: undefined,
      speakerStatus: "confirmed",
      speakerDecision: {
        decisionId: "cached",
        eligibleProfileIds: [1],
        acceptedProfileId: 1,
        rejectionReason: null,
      },
    };
    assert.equal(
      mergeTranscriptSegments([row], [incoming])[0].speakerName,
      lock ? "Manual outsider" : undefined
    );
  });
}

test("renderer final split child inherits its parent machine veto", () => {
  const parent = {
    id: "parent",
    text: "hello there",
    source: "system",
    speakerIsPlaceholder: true,
    speakerDecision: {
      decisionId: "veto",
      eligibleProfileIds: [1],
      acceptedProfileId: null,
      rejectionReason: "no_match",
    },
  };
  const child = {
    id: "child",
    parentRowId: "parent",
    text: "there",
    source: "system",
    speakerName: "A",
    speakerIsPlaceholder: false,
    speakerDecision: {
      decisionId: "cached",
      eligibleProfileIds: [1],
      acceptedProfileId: 1,
      rejectionReason: null,
    },
  };
  assert.equal(
    mergeTranscriptSegments([parent], [child]).find((row) => row.id === "child").speakerName,
    undefined
  );
});
