const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveAutomaticSpeaker } = require("../../src/helpers/automaticSpeakerAttribution");
const { enforceRows, decision, readScope } = require("../../src/helpers/noteSpeakerScope");

function fixture() {
  const profile = { id: 1, email: "a@example.com", embedding: [1, 0], voice_usable: 1 };
  const db = {
    getNote: () => ({ id: 42, participants: "[]" }),
    getSpeakerProfiles: () => [profile],
  };
  const scope = readScope(db, 42);
  const accepted = decision(scope, { path: "test", profile, profiles: [profile] });
  const veto = {
    ...accepted,
    decisionId: "prior",
    acceptedProfileId: null,
    rejectionReason: "close_match",
  };
  const row = {
    id: "row",
    speaker: "speaker_0",
    speakerDecision: veto,
    audioContentHash: "canonical",
    audioSpan: { recordingId: 1, trackId: "system", startSample: 0, endSample: 96000 },
  };
  const incoming = {
    ...row,
    speakerName: "A",
    speakerDecision: {
      ...accepted,
      evaluation: {
        rowId: row.id,
        previousDecisionId: "prior",
        audioContentHash: "canonical",
        audioSpan: row.audioSpan,
        revision: scope.revision,
        rosterRevision: scope.rosterRevision,
        profileFingerprint: accepted.profileFingerprints[0].fingerprint,
      },
    },
  };
  return { db, scope, row, incoming };
}
for (const route of ["boundary", "main enforceRows"])
  for (const alteration of ["forged", "re-upload", "track", "trim"]) {
    test(`${route} refuses plain-data proof: ${alteration}`, () => {
      const { db, scope, row, incoming } = fixture();
      if (alteration === "re-upload") incoming.audioSpan = { ...row.audioSpan, recordingId: 2 };
      if (alteration === "track") incoming.audioSpan = { ...row.audioSpan, trackId: "mic" };
      if (alteration === "trim") incoming.audioSpan = { ...row.audioSpan, endSample: 95999 };
      const actual =
        route === "boundary"
          ? resolveAutomaticSpeaker(row, row.speakerDecision, scope, incoming)
          : enforceRows(db, 42, [incoming], { storedRows: [row] })[0];
      assert.equal(actual.speakerName, undefined);
      assert.equal(actual.speakerDecision.decisionId, "prior");
      assert.ok(actual.speakerBoundary?.refusalReason);
    });
  }
test("an unrecorded automatic legacy name needs review under a declared roster; human choice survives", () => {
  const db = {
    getNote: () => ({ id: 42, participants: '[{"email":"a@example.com"}]' }),
    getSpeakerProfiles: () => [],
  };
  const rows = enforceRows(db, 42, [
    { id: "legacy", speakerName: "Outsider" },
    { id: "human", speakerName: "Chosen", speakerLockSource: "user" },
  ]);
  assert.equal(rows[0].speakerName, undefined);
  assert.equal(rows[0].speakerDecision.rejectionReason, "legacy_not_evaluated");
  assert.equal(rows[0].speakerDecision.acousticEvaluation, "not_evaluated");
  assert.equal(rows[0].speakerReviewRequired, true);
  assert.equal(rows[1].speakerName, "Chosen");
});
module.exports = { fixture };

const { prepareSpeakerRowEvaluations } = require("../../src/helpers/speakerRowEvaluation");
const { createHash } = require("node:crypto");
function audioFixture() {
  const f = fixture();
  f.row.speakerDecision.profileFingerprints = [];
  const samples = 64000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  f.row.audioContentHash = createHash("sha256")
    .update(Buffer.alloc(samples * 4))
    .digest("hex");
  f.db.getNote = () => ({ id: 42, participants: "[]", transcript: JSON.stringify([f.row]) });
  f.audio = { status: () => ({ recordingId: 1 }), span: () => ({ state: "available", wav }) };
  f.identifier = {
    getSpeakerProfiles: () => f.db.getSpeakerProfiles(),
    matchEligibleCluster: (_id, _embedding, context) => ({
      profile: context.profiles[0],
      speakerDecision: f.incoming.speakerDecision,
    }),
  };
  f.extractor = {
    isAvailable: () => true,
    extractEmbeddingFromSamples: async () => Float32Array.of(1, 0),
  };
  f.prepare = (options) =>
    prepareSpeakerRowEvaluations(f.db, f.identifier, 42, null, [], f.audio, f.extractor, options);
  f.proposal = (e) => ({
    ...f.row,
    speakerName: "A",
    speakerIsPlaceholder: false,
    audioContentHash: e.audioContentHash,
    audioSpan: e.audioSpan || f.row.audioSpan,
    speakerDecision: {
      ...f.incoming.speakerDecision,
      decisionId: e.match?.speakerDecision.decisionId || "evaluated",
      evaluation: e.evaluation || {
        ...f.incoming.speakerDecision.evaluation,
        audioContentHash: e.audioContentHash,
      },
    },
  });
  return f;
}

test("issued evidence is single use, including a replay against its exact prior row", async () => {
  const f = audioFixture();
  const e = (await f.prepare()).get("row");
  assert.ok(e);
  const incoming = f.proposal(e);
  assert.equal(
    enforceRows(f.db, 42, [{ ...incoming }], { storedRows: [f.row] })[0].speakerName,
    "A"
  );
  const replay = enforceRows(f.db, 42, [{ ...incoming }], { storedRows: [f.row] })[0];
  assert.equal(replay.speakerName, undefined);
  assert.equal(replay.speakerBoundary.refusalReason, "reused_proof");
});

test("an issued evaluation cannot be copied and rebound to another durable row", async () => {
  const f = audioFixture();
  const e = (await f.prepare()).get("row");
  const other = { ...f.row, id: "other" };
  const incoming = { ...f.proposal(e), id: "other" };
  incoming.speakerDecision = {
    ...incoming.speakerDecision,
    evaluation: { ...incoming.speakerDecision.evaluation, rowId: "other" },
  };
  const actual = enforceRows(f.db, 42, [incoming], { storedRows: [other] })[0];
  assert.equal(actual.speakerName, undefined);
});

test("an old roster handle cannot claim a newer revision", async () => {
  const f = audioFixture();
  const e = (await f.prepare()).get("row");
  const incoming = f.proposal(e);
  f.db.getNote = () => ({ id: 42, participants: "[]", speaker_roster_revision: 1 });
  const current = readScope(f.db, 42);
  incoming.speakerDecision = {
    ...incoming.speakerDecision,
    ...current,
    evaluation: {
      ...incoming.speakerDecision.evaluation,
      revision: current.revision,
      rosterRevision: 1,
    },
  };
  assert.equal(
    enforceRows(f.db, 42, [incoming], { storedRows: [f.row] })[0].speakerName,
    undefined
  );
});

for (const alteration of ["track", "trim", "content"])
  test(`issued evidence verifies canonical audio: ${alteration}`, async () => {
    const f = audioFixture();
    const e = (await f.prepare()).get("row");
    const incoming = f.proposal(e);
    if (alteration === "track") incoming.audioSpan = { ...incoming.audioSpan, trackId: "mic" };
    if (alteration === "trim") incoming.audioSpan = { ...incoming.audioSpan, endSample: 95999 };
    if (alteration === "content") incoming.audioContentHash = "other";
    const actual = enforceRows(f.db, 42, [incoming], { storedRows: [f.row] })[0];
    assert.equal(actual.speakerName, undefined);
    assert.equal(actual.speakerBoundary.refusalReason, "audio");
  });

test("same-audio reupload requires both a canonical hash and explicit intact recording lineage", async () => {
  const f = audioFixture();
  const old = (await f.prepare()).get("row");
  const copied = f.proposal(old);
  copied.audioSpan = { ...copied.audioSpan, recordingId: 2 };
  assert.equal(enforceRows(f.db, 42, [copied], { storedRows: [f.row] })[0].speakerName, undefined);
  f.audio.status = () => ({ recordingId: 2 });
  const replacement = {
    kind: "reupload",
    previousDecisionId: "prior",
    parentRecordingId: 1,
    audioSpan: { ...f.row.audioSpan, recordingId: 2 },
  };
  const e = (await f.prepare({ replacements: new Map([["row", replacement]]) })).get("row");
  assert.ok(e);
  assert.equal(enforceRows(f.db, 42, [f.proposal(e)], { storedRows: [f.row] })[0].speakerName, "A");
  replacement.parentRecordingId = "broken";
  assert.equal((await f.prepare({ replacements: new Map([["row", replacement]]) })).size, 0);
  replacement.parentRecordingId = 1;
  replacement.audioSpan = { ...replacement.audioSpan, trackId: "mic" };
  assert.equal(
    (await f.prepare({ replacements: new Map([["row", replacement]]) })).size,
    0,
    "an equivalence reupload cannot swap tracks"
  );
  replacement.audioSpan = { ...replacement.audioSpan, trackId: "system", endSample: 95999 };
  assert.equal(
    (await f.prepare({ replacements: new Map([["row", replacement]]) })).size,
    0,
    "an equivalence reupload cannot trim samples"
  );
});

test("validated replacement recovers even when original audio is unavailable", async () => {
  const f = audioFixture();
  f.audio.status = () => ({ recordingId: 2 });
  const replacement = {
    kind: "replacement",
    previousDecisionId: "prior",
    parentRecordingId: 1,
    audioSpan: { ...f.row.audioSpan, recordingId: 2 },
  };
  assert.equal((await f.prepare()).size, 0);
  const e = (await f.prepare({ replacements: new Map([["row", replacement]]) })).get("row");
  assert.ok(e);
  const actual = enforceRows(f.db, 42, [f.proposal(e)], { storedRows: [f.row] })[0];
  assert.equal(actual.speakerName, "A");
  assert.equal(actual.audioSpan.recordingId, 2);
});

test("2000-row reevaluation yields to a heartbeat and snapshots the profiles once per batch", async (t) => {
  const f = audioFixture();
  const rows = Array.from({ length: 2000 }, (_, i) => ({
    ...f.row,
    id: `batch-${i}`,
    audioContentHash: undefined,
  }));
  f.db.getNote = () => ({ id: 42, participants: "[]", transcript: JSON.stringify(rows) });
  let reads = 0,
    heartbeats = 0;
  f.identifier.getSpeakerProfiles = () => {
    reads++;
    return f.db.getSpeakerProfiles();
  };
  // Exercise the production loop; decoding is stubbed at its process boundary.
  t.mock.method(
    require("../../src/helpers/speakerClusterSplit"),
    "wavTo16kSamples",
    () => new Float32Array(64)
  );
  const child = require("node:child_process");
  t.mock.method(child, "execFile", (_file, _args, _options, callback) => {
    setImmediate(() => callback(null, Buffer.alloc(256)));
    return { stdin: { on() {}, end() {} } };
  });
  const timer = setInterval(() => heartbeats++, 0);
  const started = performance.now();
  try {
    const result = await f.prepare();
    console.log(
      `RUN6_REEVALUATION rows=2000 ms=${(performance.now() - started).toFixed(1)} heartbeats=${heartbeats} profileReads=${reads}`
    );
    assert.equal(result.size, 2000);
    assert.ok(heartbeats > 5);
    assert.equal(reads, 1);
  } finally {
    clearInterval(timer);
  }
});

test("main records a stale issued revision while retaining the controlling veto", async () => {
  const f = audioFixture();
  const e = (await f.prepare()).get("row");
  const incoming = f.proposal(e);
  f.db.getNote = () => ({ id: 42, participants: "[]", speaker_roster_revision: 1 });
  const actual = enforceRows(f.db, 42, [incoming], { storedRows: [f.row] })[0];
  assert.equal(actual.speakerName, undefined);
  assert.equal(actual.speakerDecision.decisionId, "prior");
  assert.equal(actual.speakerBoundary.refusalReason, "revision");
});

test("main records a changed profile while retaining the controlling veto", async () => {
  const f = audioFixture();
  const e = (await f.prepare()).get("row");
  const incoming = f.proposal(e),
    before = f.db.getSpeakerProfiles()[0];
  f.db.getSpeakerProfiles = () => [{ ...before, embedding: [0, 1] }];
  const actual = enforceRows(f.db, 42, [incoming], { storedRows: [f.row] })[0];
  assert.equal(actual.speakerName, undefined);
  assert.equal(actual.speakerDecision.decisionId, "prior");
  assert.equal(actual.speakerBoundary.refusalReason, "profile");
});

test("an issued handle binds the evaluated winner rather than a caller-selected current profile", async () => {
  const f = audioFixture();
  const first = f.db.getSpeakerProfiles()[0];
  const second = { ...first, id: 2, email: "b@example.com", display_name: "B", embedding: [0, 1] };
  f.db.getSpeakerProfiles = () => [first, second];
  const e = (await f.prepare()).get("row");
  const incoming = f.proposal(e);
  const { profileFingerprint } = require("../../src/helpers/noteSpeakerScope");
  incoming.speakerName = "B";
  incoming.speakerDecision = {
    ...incoming.speakerDecision,
    acceptedProfileId: 2,
    eligibleProfileIds: [1, 2],
    profileFingerprints: [first, second].map((p) => ({
      id: p.id,
      fingerprint: profileFingerprint(p),
    })),
  };
  if (!e.match) incoming.speakerDecision.evaluation.profileFingerprint = profileFingerprint(second);
  const actual = enforceRows(f.db, 42, [incoming], { storedRows: [f.row] })[0];
  assert.equal(actual.speakerName, undefined);
  assert.equal(actual.speakerBoundary.refusalReason, "profile");
});

for (const route of ["boundary", "main"])
  test(`${route} refuses a fabricated initial evaluation with no stored veto`, () => {
    const f = fixture();
    const row = { ...f.row, speakerDecision: undefined };
    const actual =
      route === "boundary"
        ? resolveAutomaticSpeaker(row, null, f.scope, f.incoming)
        : enforceRows(f.db, 42, [f.incoming], { storedRows: [] })[0];
    assert.equal(actual.speakerName, undefined);
    assert.equal(actual.speakerDecision.acceptedProfileId, null);
    assert.equal(actual.speakerBoundary.refusalReason, "missing_proof");
  });

test("a stored acceptance cannot carry its serialized proof onto swapped canonical audio", () => {
  const f = fixture();
  const row = { ...f.incoming };
  const next = { ...row, audioSpan: { ...row.audioSpan, trackId: "mic" } };
  const actual = enforceRows(f.db, 42, [next], { storedRows: [row] })[0];
  assert.equal(actual.speakerName, undefined);
  assert.equal(actual.speakerDecision.acceptedProfileId, null);
  assert.equal(actual.speakerBoundary.refusalReason, "missing_proof");
});

test("legacy speaker-string names require review while portable known human choices survive", () => {
  const db = {
    getNote: () => ({ id: 42, participants: '[{"email":"a@example.com"}]' }),
    getSpeakerProfiles: () => [],
  };
  const rows = enforceRows(db, 42, [
    { id: "old", speaker: "Outsider" },
    { id: "human", speakerName: "Chosen", speakerAssignment: { origin: "human" } },
  ]);
  assert.equal(rows[0].speakerDecision.rejectionReason, "legacy_not_evaluated");
  assert.equal(rows[0].speakerReviewRequired, true);
  assert.equal(rows[1].speakerName, "Chosen");
  const renamed = resolveAutomaticSpeaker(rows[1], rows[1].speakerDecision, readScope(db, 42), {
    id: "human",
    speakerName: "Automatic",
  });
  assert.equal(renamed.speakerName, "Chosen");
  assert.equal(renamed.speakerAssignment.origin, "human");
});

test("a rejected unsafe proposal retains the controlling veto even with otherwise valid issued proof", async () => {
  const f = audioFixture();
  const e = (await f.prepare()).get("row");
  const incoming = { ...f.proposal(e), overlap: true };
  const actual = resolveAutomaticSpeaker(f.row, f.row.speakerDecision, f.scope, incoming);
  assert.equal(actual.speakerName, undefined);
  assert.equal(actual.speakerDecision.decisionId, "prior");
  assert.equal(actual.speakerBoundary.refusalReason, "audio");
});

test("successful installation records the evaluator result rather than caller-edited diagnostics", async () => {
  const f = audioFixture();
  const e = (await f.prepare()).get("row");
  const incoming = f.proposal(e);
  incoming.speakerDecision = {
    ...incoming.speakerDecision,
    scores: { best: 42 },
    modelFingerprint: "fabricated-model",
    path: "fabricated-path",
  };
  const actual = enforceRows(f.db, 42, [incoming], { storedRows: [f.row] })[0];
  assert.equal(actual.speakerName, "A");
  assert.equal(actual.speakerDecision.scores, null);
  assert.equal(actual.speakerDecision.modelFingerprint, null);
  assert.equal(actual.speakerDecision.path, "test");
});

for (const alteration of ["recording", "track", "sample", "hash"])
  test(`a rejected proposal cannot poison the canonical audio binding: ${alteration}`, () => {
    const f = fixture();
    const incoming = { ...f.row, audioSpan: { ...f.row.audioSpan } };
    if (alteration === "recording") incoming.audioSpan.recordingId = 2;
    if (alteration === "track") incoming.audioSpan.trackId = "mic";
    if (alteration === "sample") incoming.audioSpan.endSample--;
    if (alteration === "hash") incoming.audioContentHash = "forged-stored-hash";
    const actual = enforceRows(f.db, 42, [incoming], { storedRows: [f.row] })[0];
    assert.deepEqual(actual.audioSpan, f.row.audioSpan);
    assert.equal(actual.audioContentHash, "canonical");
    assert.equal(actual.speakerDecision.decisionId, "prior");
    assert.equal(actual.speakerBoundary.refusalReason, "audio");
  });

test("omitting stored audio metadata cannot remove its binding before a later swap", () => {
  const f = fixture();
  const row = { ...f.incoming };
  const dropped = {
    ...row,
    audioContentHash: undefined,
    audioSpan: undefined,
    speakerDecision: { ...row.speakerDecision, evaluation: undefined },
  };
  const preserved = enforceRows(f.db, 42, [dropped], { storedRows: [row] })[0];
  assert.equal(preserved.audioContentHash, "canonical");
  assert.deepEqual(preserved.audioSpan, row.audioSpan);
  assert.deepEqual(preserved.speakerDecision.evaluation, row.speakerDecision.evaluation);
  const swapped = {
    ...preserved,
    audioSpan: { ...row.audioSpan, trackId: "mic" },
    speakerDecision: { ...preserved.speakerDecision, evaluation: undefined },
  };
  const actual = enforceRows(f.db, 42, [swapped], { storedRows: [preserved] })[0];
  assert.equal(actual.speakerName, undefined);
  assert.equal(actual.speakerDecision.acceptedProfileId, null);
});
