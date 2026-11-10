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
    const serialized = publicTranscript(
      writeTranscriptDocument([{ id: "row", text: "hello", ...row }])
    );
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

test("late accepted final cannot replace an identical row's veto", () => {
  const { reconcileAutomaticTranscript } = require("../../src/helpers/transcriptDocument");
  const decision = {
    decisionId: "veto",
    noteId: 1,
    revision: "r",
    eligibleProfileIds: [1],
    acceptedProfileId: null,
    rejectionReason: "no_match",
  };
  const row = {
    id: "r",
    text: "hello",
    source: "system",
    audioSpan: { recordingId: 1, trackId: "system", startSample: 0, endSample: 96000 },
    speakerIsPlaceholder: true,
    speakerDecision: decision,
  };
  const incoming = {
    ...row,
    speakerName: "A",
    speakerIsPlaceholder: false,
    speakerDecision: {
      ...decision,
      decisionId: "cached",
      acceptedProfileId: 1,
      rejectionReason: null,
    },
  };
  const actual = readTranscriptDocument(
    reconcileAutomaticTranscript(
      writeTranscriptDocument([incoming]),
      writeTranscriptDocument([row])
    )
  ).rows[0];
  assert.equal(actual.speakerName, undefined);
  assert.deepEqual(actual.speakerDecision, decision);
});

test("a final split child inherits its parent veto without changing its child audio span", () => {
  const { reconcileAutomaticTranscript } = require("../../src/helpers/transcriptDocument");
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
  const span = { recordingId: 1, trackId: "system", startSample: 48000, endSample: 96000 };
  const child = {
    id: "child",
    parentRowId: "parent",
    text: "there",
    source: "system",
    audioSpan: span,
    speakerName: "A",
    speakerIsPlaceholder: false,
    speakerDecision: {
      decisionId: "cached",
      eligibleProfileIds: [1],
      acceptedProfileId: 1,
      rejectionReason: null,
    },
  };
  const actual = readTranscriptDocument(
    reconcileAutomaticTranscript(
      writeTranscriptDocument([child]),
      writeTranscriptDocument([parent])
    )
  ).rows[0];
  assert.equal(actual.speakerName, undefined);
  assert.deepEqual(actual.audioSpan, span);
});
