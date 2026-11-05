const test = require("node:test");
const assert = require("node:assert/strict");

test("committed approval remains visible when the candidate reload fails", async () => {
  const { saveEnrollmentDecision } =
    await import("../../src/components/settings/enrollmentDecision.ts");
  const candidate = {
    id: "candidate-1",
    profileId: 7,
    noteId: 12,
    noteTitle: "Meeting",
    meetingDate: "2026-11-03",
    rowIds: ["row-1"],
    durationSeconds: 4,
  };
  const api = {
    decideVoiceEnrollmentCandidate: async () => ({ success: true }),
    listVoiceEnrollmentCandidates: async () => {
      throw Error("refresh failed");
    },
    listVoiceEnrollmentSamples: async () => [],
  };
  const result = await saveEnrollmentDecision(
    candidate,
    "approve",
    "proof",
    api,
    [candidate],
    [],
    async () => {}
  );
  assert.equal(result.committed, true);
  assert.equal(result.error, "refresh_failed");
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(
    result.samples.map((sample) => sample.id),
    ["candidate-1"]
  );
});

test("a failed save keeps the candidate and reports its exact error", async () => {
  const { saveEnrollmentDecision } =
    await import("../../src/components/settings/enrollmentDecision.ts");
  const candidate = {
    id: "candidate-2",
    profileId: 7,
    noteId: 12,
    noteTitle: "Meeting",
    meetingDate: "2026-11-03",
    rowIds: ["row-1"],
    durationSeconds: 4,
  };
  const result = await saveEnrollmentDecision(
    candidate,
    "approve",
    "proof",
    {
      decideVoiceEnrollmentCandidate: async () => ({ success: false, error: "database_busy" }),
    },
    [candidate],
    [],
    async () => {}
  );
  assert.equal(result.committed, false);
  assert.equal(result.error, "database_busy");
  assert.deepEqual(result.candidates, [candidate]);
});

test("committed approval remains visible when the People refresh fails", async () => {
  const { saveEnrollmentDecision } =
    await import("../../src/components/settings/enrollmentDecision.ts");
  const candidate = {
    id: "candidate-3",
    profileId: 7,
    noteId: 12,
    noteTitle: "Meeting",
    meetingDate: "2026-11-03",
    rowIds: ["row-1"],
    durationSeconds: 4,
  };
  const api = {
    decideVoiceEnrollmentCandidate: async () => ({ success: true }),
    listVoiceEnrollmentCandidates: async () => ({ candidates: [], reasons: {} }),
    listVoiceEnrollmentSamples: async () => [{ ...candidate, odd: false }],
  };
  const result = await saveEnrollmentDecision(
    candidate,
    "approve",
    "proof",
    api,
    [candidate],
    [],
    async () => {
      throw Error("People refresh failed");
    }
  );
  assert.equal(result.committed, true);
  assert.equal(result.error, "refresh_failed");
  assert.deepEqual(
    result.samples.map((sample) => sample.id),
    ["candidate-3"]
  );
});
