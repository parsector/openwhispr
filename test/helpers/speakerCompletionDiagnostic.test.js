const test = require("node:test");
const assert = require("node:assert/strict");
const { collectRows } = require("../../src/helpers/speakerInAppCalibration");
const { ADMISSION_CRITERIA } = require("../../src/helpers/speakerCalibrationPolicy");
const { SUPPORTED_UI_LANGUAGES } = require("../../src/helpers/i18nMain");

function collect(completion, embeddings = []) {
  const note = {
    id: 62,
    transcript: JSON.stringify([
      {
        id: "reviewed",
        speaker: "speaker_7",
        speakerName: "Ada",
        speakerLockSource: "user",
        source: "system",
        audioSpan: { trackId: "system", recordingId: 1, startSample: 0, endSample: 48000 },
      },
    ]),
    speaker_action_log: null,
  };
  const before = JSON.stringify(note);
  const result = collectRows(
    {
      db: { prepare: () => ({ all: () => [note] }) },
      getNoteSpeakerEmbeddings: () => embeddings,
      getNoteSpeakerCompletion: () => completion,
    },
    { status: () => ({ state: "expired", tracks: {} }) },
    { kind: "all" },
    { notes: 1, rows: 10 }
  );
  assert.equal(JSON.stringify(note), before, "reviewed labels are preserved");
  assert.equal(result.rows[0].truePerson, "Ada");
  return result;
}

const cases = [
  [
    "diarization skipped",
    { cause: "diarization_skipped", clusters: 0, vectorsWritten: 0 },
    "skipped",
    /Diarization was skipped/,
  ],
  [
    "diarization failed",
    { cause: "diarization_failed", clusters: 0, vectorsWritten: 0 },
    "diarizationFailed",
    /Diarization failed/,
  ],
  [
    "extraction failed",
    { cause: "embedding_extraction_failed", clusters: 2, vectorsWritten: 0 },
    "extractionFailed",
    /extraction failed/,
  ],
  [
    "persistence rejected",
    { cause: "write_rejected:row_count_mismatch", clusters: 2, vectorsWritten: 0 },
    "persistenceRejected",
    /persistence was rejected/,
  ],
  [
    "speaker key mismatch",
    { cause: null, clusters: 2, vectorsWritten: 2 },
    "keyMismatch",
    /keys do not match/,
  ],
  ["no completion event", null, "noCompletion", /No completion event recorded/],
  [
    "migrated zero counters",
    { cause: null, clusters: 0, vectorsWritten: 0, hadSpeakerEmbeddings: true },
    "unknown",
    /not recorded/,
  ],
  ["unknown legacy completion", { hadSpeakerEmbeddings: false }, "unknown", /not recorded/],
  [
    "model unavailable",
    { cause: "model_unavailable", clusters: 2, vectorsWritten: 0 },
    "modelUnavailable",
    /model unavailable/,
  ],
  [
    "no eligible segments",
    { cause: "no_eligible_segments", clusters: 2, vectorsWritten: 0 },
    "noEligibleSegments",
    /No eligible segments/,
  ],
  [
    "audio unavailable",
    { cause: "audio_state:expired", clusters: 2, vectorsWritten: 0 },
    "audioUnavailable",
    /Audio state prevented/,
  ],
];

for (const [name, completion, key, message] of cases) {
  test(`completion cause renders its own message: ${name}`, () => {
    const embeddings =
      name === "speaker key mismatch"
        ? [
            {
              speaker_id: "different_key",
              embedding: Buffer.from(new Float32Array([1, 0]).buffer),
            },
          ]
        : [];
    const result = collect(completion, embeddings);
    const diagnostic = result.missingVectorDiagnostics[0];
    assert.equal(diagnostic.messageKey, `people.calibrationCompletion.${key}`);
    assert.match(diagnostic.message, message);
    assert.equal(diagnostic.cause, completion?.cause || null);
    if (key === "unknown" || !completion) {
      assert.equal(diagnostic.clusters, null);
      assert.equal(diagnostic.vectorsWritten, null);
      assert.doesNotMatch(diagnostic.message, /0 of 0/);
    }
  });
}

test("a real completion cause is visible even when the reviewed vector is present", () => {
  const result = collect({ cause: "embedding_extraction_failed", clusters: 2, vectorsWritten: 1 }, [
    {
      speaker_id: "speaker_7",
      embedding: Buffer.from(new Float32Array([1, 0]).buffer),
    },
  ]);
  assert.equal(result.missingVectorDiagnostics[0].reason, "embedding_extraction_failed");
  assert.match(result.missingVectorDiagnostics[0].message, /1 of 2 cluster vectors written/);
});

test("every active locale translates all dynamic admission and completion messages", () => {
  for (const locale of SUPPORTED_UI_LANGUAGES) {
    const { people } = require(`../../src/locales/${locale}/translation.json`);
    for (const criterion of ADMISSION_CRITERIA)
      assert.ok(people.calibrationAdmission[criterion], `${locale}: ${criterion}`);
    for (const [, , key] of cases)
      assert.ok(people.calibrationCompletion[key], `${locale}: ${key}`);
  }
});
