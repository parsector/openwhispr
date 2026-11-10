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

test('run6: a new transcription identity never inherits a veto through fuzzy text or time',()=>{
  const old={id:'old',text:'hello',source:'system',timestamp:1,speakerIsPlaceholder:true,speakerDecision:{decisionId:'veto',acceptedProfileId:null,eligibleProfileIds:[1],rejectionReason:'not_sure'}};
  const replacement={id:'replacement',text:'hello',source:'system',timestamp:1,speakerName:'A',speakerDecision:{decisionId:'new',acceptedProfileId:1,eligibleProfileIds:[1],rejectionReason:null}};
  const actual=mergeTranscriptSegments([old],[replacement]);
  assert.equal(actual.find(r=>r.id==='replacement')?.speakerName,'A');
  assert.equal(actual.length,1);
});

test("run8: context-free parsing, chat normalization and serialization preserve undecided legacy attribution", () => {
  const { parseTranscriptSegments } = require("../../src/utils/parseTranscriptSegments.ts");
  const {
    normalizeTranscriptSegments,
    serializeTranscriptSegments,
  } = require("../../src/utils/transcriptSpeakerState.ts");
  const { readTranscriptDocument } = require("../../src/helpers/transcriptDocument");
  for (const history of [{ uncertainty: { reason: "close_match" } }, { overlap: true }]) {
    const row = { id: "r", text: "Hello", speakerName: "Alice", ...history };
    const parsed = parseTranscriptSegments(JSON.stringify([row]), "note");
    const chat = normalizeTranscriptSegments(parsed);
    const saved = readTranscriptDocument(serializeTranscriptSegments(chat)).rows;
    for (const actual of [parsed[0], chat[0], saved[0]]) {
      assert.equal(actual.speakerName, "Alice");
      assert.equal(actual.speakerDecision, undefined);
      assert.deepEqual(actual.uncertainty, row.uncertainty);
    }
  }
});
