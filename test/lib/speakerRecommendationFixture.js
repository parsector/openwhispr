const { createHash } = require("node:crypto");
const { RECOMMENDATION_POLICY } = require("../../src/helpers/speakerCalibrationPolicy");

// Illustrative production observations evaluated against the product admission policy.
function recommendationFixture() {
  const profiles = [
    { id: 1, name: "Ada", vector: [1, 0] },
    { id: 2, name: "Ben", vector: [0, 1] },
  ];
  return {
    rows: Array.from({ length: 40 }, (_, i) => ({
      noteId: 1 + Math.floor(i / 4),
      recordingSessionId: `tuning-${Math.floor(i / 4)}`,
      rowId: `row-${i}`,
      revision: `revision-${i}`,
      truePerson: i % 2 ? "Ben" : "Ada",
      machineLabel: i % 2 ? "Ben" : "Ada",
      clusterId: i % 2 ? "2" : "1",
      vector: i % 2 ? [0.1, 0.99] : [0.99, 0.1],
      audioFingerprint: "a".repeat(64),
    })),
    profiles,
    scope: { kind: "all" },
    modelFingerprint: "b".repeat(64),
    policy: { ...RECOMMENDATION_POLICY },
    validationEvidence: {
      source: "production-decisions",
      modelFingerprint: "b".repeat(64),
      profileFingerprint: createHash("sha256")
        .update(JSON.stringify(profiles.map((p) => [p.id, p.name, p.vector])))
        .digest("hex"),
      policy: { similarityFloor: 0.75, runnerUpMargin: 0.1 },
      observations: [
        { recordingSessionId: "holdout-1", truePerson: "Ada", predictedPerson: "Ada" },
        { recordingSessionId: "holdout-2", truePerson: "Ben", predictedPerson: "Ben" },
        { recordingSessionId: "holdout-3", truePerson: null, predictedPerson: null },
        { recordingSessionId: "holdout-3", truePerson: "Unenrolled", predictedPerson: null },
      ],
    },
  };
}

module.exports = { recommendationFixture };
