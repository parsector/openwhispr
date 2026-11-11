const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");
const { recordedNameAllowed, humanProtected } = require("../../src/helpers/speakerRosterPolicy");

const NOTE_ID = 31;
const accepted = {
  candidateSetStatus: "recorded",
  origin: "machine",
  decisionId: "accepted",
  runId: "run",
  noteId: NOTE_ID,
  source: "note",
  revision: "roster",
  rosterRevision: 0,
  rawRoster: "[]",
  roster: [],
  eligibleProfileIds: [1],
  acceptedProfileId: 1,
  acceptedIdentity: { email: "a@example.com" },
  rejectionReason: null,
  profileFingerprints: [{ id: 1, fingerprint: "current-profile" }],
};
const veto = {
  ...accepted,
  decisionId: "veto",
  acceptedProfileId: null,
  acceptedIdentity: null,
  rejectionReason: "close_match",
};

async function fixture(t) {
  let store;
  t.after(() => store?.stopRecording());
  const callbacks = {};
  const api = {
    checkSystemAudioAccess: async () => ({
      granted: true,
      status: "granted",
      mode: "native",
      strategy: "native",
    }),
    meetingTranscriptionStart: async () => ({
      success: true,
      systemAudioMode: "native",
      systemAudioStrategy: "native",
    }),
    meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
    meetingTranscriptionStop: async () => ({ success: true }),
    meetingTranscriptionSend() {},
    getNote: async () => ({
      id: NOTE_ID,
      participants: "[]",
      speaker_roster_revision: 0,
      transcript: "[]",
    }),
    updateNote: async () => ({ success: true }),
    reconsiderLiveSpeakers: async () => callbacks.reconsidered,
  };
  for (const event of [
    "MeetingTranscriptionSegment",
    "MeetingSpeakerIdentified",
    "MeetingSpeakersMerged",
    "MeetingSpeakerEvidenceChanged",
    "NoteUpdated",
  ])
    api[`on${event}`] = (callback) => {
      callbacks[event] = callback;
      return () => {};
    };
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, { window: { electronAPI: api, setTimeout } });
  const vite = await createRendererServer(t, { cachePrefix: "ow-speaker-replay-" });
  store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  assert.equal(
    await store.startRecording({ noteId: NOTE_ID, noteTitle: "Replay", folderId: null }),
    true
  );
  const now = Date.now();
  const rows = () => store.useMeetingRecordingStore.getState().segments;
  const final = (text, timestamp) =>
    callbacks.MeetingTranscriptionSegment({ type: "final", source: "system", text, timestamp });
  const identify = (speakerId, startTime, endTime, decision = accepted, displayName = "A") =>
    callbacks.MeetingSpeakerIdentified({
      cohort: "system",
      speakerId,
      startTime,
      endTime,
      displayName,
      speakerDecision: decision,
    });
  return { store, callbacks, now, rows, final, identify };
}

for (const replay of ["identification", "cached windows", "cluster merge"]) {
  test(`a durable machine veto survives ${replay}`, async (t) => {
    const f = await fixture(t);
    f.final("vetoed", f.now);
    f.identify("speaker_0", f.now - 100, f.now + 500);
    const rejected = {
      ...f.rows()[0],
      speakerName: undefined,
      speakerIsPlaceholder: true,
      audioSpan: { recordingId: 1, trackId: "system", startSample: 0, endSample: 32000 },
      audioContentHash: "row-audio",
      uncertainty: { reason: "close_match" },
      speakerDecision: veto,
    };
    f.callbacks.NoteUpdated({
      id: NOTE_ID,
      participants: "[]",
      speaker_roster_revision: 0,
      transcript: JSON.stringify([rejected]),
    });
    if (replay === "identification") f.identify("speaker_0", f.now - 100, f.now + 600);
    if (replay === "cached windows") f.identify("speaker_1", f.now + 1000, f.now + 1500);
    if (replay === "cluster merge")
      f.callbacks.MeetingSpeakersMerged([
        { keep: "speaker_1", remove: "speaker_0", displayName: "A", speakerDecision: accepted },
      ]);
    const row = f.rows()[0];
    assert.equal(row.speakerName, undefined);
    assert.equal(row.suggestedName, undefined);
    assert.equal(row.speakerIsPlaceholder, true);
    assert.equal(recordedNameAllowed(row), false);
    assert.equal(humanProtected(row), false);
    assert.deepEqual(row.speakerDecision, veto);
    if (replay === "cluster merge") assert.equal(row.speaker, "speaker_1");
    const cachedCommit = {
      ...row,
      speakerName: "A",
      speakerIsPlaceholder: false,
      speakerDecision: { ...accepted, decisionId: "new-id-same-audio" },
    };
    f.store.mergeCommittedSpeakerRows([cachedCommit]);
    assert.equal(
      recordedNameAllowed(f.rows()[0]),
      false,
      "a new decision id alone is not new row audio"
    );
    f.store.mergeCommittedSpeakerRows([
      {
        ...cachedCommit,
        audioSpan: { endSample: 32000, startSample: 0, trackId: "system", recordingId: 1 },
      },
    ]);
    assert.equal(
      recordedNameAllowed(f.rows()[0]),
      false,
      "serialized field order is not new audio"
    );
    const fresh = {
      ...cachedCommit,
      uncertainty: undefined,
      audioSpan: { recordingId: 1, trackId: "system", startSample: 0, endSample: 32000 },
    };
    f.store.mergeCommittedSpeakerRows([
      { ...fresh, speakerDecision: { ...accepted, rosterRevision: 99 } },
    ]);
    assert.equal(
      recordedNameAllowed(f.rows()[0]),
      false,
      "fresh audio still requires the current roster"
    );
    // A fresh evaluation of the same canonical audio can replace a machine veto.
    f.store.mergeCommittedSpeakerRows([
      {
        ...fresh,
        speakerDecision: {
          ...accepted,
          decisionId: "fresh-row-evaluation",
          previousDecision: veto,
          evaluation: {
            rowId: rejected.id,
            previousDecisionId: veto.decisionId,
            audioContentHash: "row-audio",
            revision: accepted.revision,
            rosterRevision: accepted.rosterRevision,
            profileFingerprint: "current-profile",
          },
        },
      },
    ]);
    assert.equal(f.rows()[0].speakerName, undefined, "a serialized proof has no authority");
    f.callbacks.NoteUpdated({
      id: NOTE_ID,
      participants: "[]",
      speaker_roster_revision: 0,
      transcript: JSON.stringify([
        { ...fresh, speakerDecision: { ...accepted, decisionId: "persisted-evaluation" } },
      ]),
    });
    assert.equal(f.rows()[0].speakerName, "A");
    assert.equal(recordedNameAllowed(f.rows()[0]), true);
    assert.equal(humanProtected(f.rows()[0]), false);
  });
}

for (const path of [
  "cluster merge",
  "commit",
  "reconsideration",
  "correction restore",
  "undo restore",
]) {
  test(`speaker caches preserve siblings through ${path}`, async (t) => {
    const f = await fixture(t);
    f.final("affected", f.now);
    f.identify("speaker_0", f.now - 100, f.now + 500);
    f.final("sibling", f.now + 1000);
    f.identify("speaker_1", f.now + 900, f.now + 1500, accepted, "Sibling");
    const changedDecision = {
      ...accepted,
      decisionId: "updated",
      acceptedProfileId: 2,
      eligibleProfileIds: [2],
      acceptedIdentity: { email: "b@example.com" },
    };
    const changed = { ...f.rows()[0], speakerName: "B", speakerDecision: changedDecision };
    if (path === "cluster merge") {
      f.callbacks.MeetingSpeakersMerged([
        {
          keep: "speaker_1",
          remove: "speaker_0",
          displayName: "B",
          speakerDecision: changedDecision,
        },
      ]);
      assert.equal(f.rows().find((row) => row.text === "affected").speaker, "speaker_1");
    } else if (path === "reconsideration") {
      f.callbacks.reconsidered = {
        rows: [changed],
        assignments: [{ speakerId: "speaker_0", displayName: "B", rows: [changed] }],
      };
      await f.callbacks.MeetingSpeakerEvidenceChanged({
        noteId: NOTE_ID,
        runId: f.store.getActiveRecordingSessionId(),
      });
    } else {
      f.store.mergeCommittedSpeakerRows(
        [changed],
        path.includes("restore") ? { affectedRowIds: [changed.id] } : {}
      );
      if (path.includes("restore"))
        f.store.restoreSpeakerIdentityCache("speaker_0", path === "undo restore" ? null : "B");
    }
    f.final("covered sibling", f.now + 1100);
    assert.equal(f.rows().find((row) => row.text === "covered sibling").speakerName, "Sibling");
    f.final("covered affected", f.now + 100);
    const affected = f.rows().find((row) => row.text === "covered affected");
    assert.equal(affected.speakerName, "B");
    assert.equal(affected.speakerAssessmentAvailable, true);
    assert.deepEqual(affected.speakerDecision, changedDecision);
  });
}

for (const change of ["track", "recording", "sample"]) {
  test(`coordinate-only supersession (${change}) is refused`, async (t) => {
    const f = await fixture(t);
    f.final("vetoed", f.now);
    const span = { recordingId: 1, trackId: "system", startSample: 0, endSample: 96000 };
    const rejected = {
      ...f.rows()[0],
      audioSpan: span,
      speakerDecision: veto,
      speakerIsPlaceholder: true,
    };
    f.store.mergeCommittedSpeakerRows([rejected]);
    const changed = {
      ...span,
      ...(change === "track"
        ? { trackId: "mic" }
        : change === "recording"
          ? { recordingId: 2 }
          : { endSample: 95999 }),
    };
    f.store.mergeCommittedSpeakerRows([
      {
        ...rejected,
        audioSpan: changed,
        speakerName: "A",
        speakerIsPlaceholder: false,
        speakerDecision: accepted,
      },
    ]);
    assert.equal(f.rows()[0].speakerName, undefined);
    assert.equal(f.rows()[0].speakerDecision.rejectionReason, "close_match");
  });
}

test("splitting one accepted row partitions its shared cache window and undo keeps sibling evidence", async (t) => {
  const f = await fixture(t);
  f.final("selected", f.now);
  f.final("sibling", f.now + 1000);
  f.identify("speaker_0", f.now - 100, f.now + 1500);
  const [selected, sibling] = f.rows();
  f.store.mergeCommittedSpeakerRows(
    [
      {
        ...selected,
        speaker: "speaker_1",
        speakerName: undefined,
        speakerIsPlaceholder: true,
        uncertainty: { reason: "possible_mixed_speakers" },
      },
      sibling,
    ],
    { affectedRowIds: [selected.id] }
  );
  f.final("sibling replay", f.now + 1100);
  const replay = f.rows().find((row) => row.text === "sibling replay");
  assert.equal(replay.speakerName, "A");
  assert.equal(replay.speaker, "speaker_0");
  f.store.restoreSpeakerIdentityCache("speaker_0", null);
  f.final("sibling after undo", f.now + 1200);
  assert.equal(f.rows().find((row) => row.text === "sibling after undo").speakerName, "A");
});

test("restoration cannot bypass a veto outside the action affected rows", async (t) => {
  const f = await fixture(t);
  f.final("affected", f.now);
  f.final("unaffected", f.now + 1000);
  const rejected = f
    .rows()
    .map((row) => ({ ...row, speakerDecision: veto, speakerIsPlaceholder: true }));
  f.store.mergeCommittedSpeakerRows(rejected);
  f.store.mergeCommittedSpeakerRows(
    rejected.map((row) => ({
      ...row,
      speakerName: "A",
      speakerIsPlaceholder: false,
      speakerDecision: accepted,
    })),
    { restoreDecisions: true, affectedRowIds: [rejected[0].id] }
  );
  assert.equal(f.rows()[1].speakerName, undefined);
});

for (const fresh of [false, true]) {
  test(`reconsideration ${fresh ? "with" : "without"} fresh canonical row evaluation ${fresh ? "names the row" : "keeps its veto"}`, async (t) => {
    const f = await fixture(t);
    f.final("vetoed", f.now);
    f.identify("speaker_0", f.now - 100, f.now + 500);
    const row = {
      ...f.rows()[0],
      speakerName: undefined,
      speakerIsPlaceholder: true,
      speakerDecision: veto,
      audioContentHash: "canonical-row",
      audioSpan: { recordingId: 1, trackId: "system", startSample: 0, endSample: 96000 },
    };
    f.callbacks.NoteUpdated({
      id: NOTE_ID,
      participants: "[]",
      speaker_roster_revision: 0,
      transcript: JSON.stringify([row]),
    });
    const evidence = {
      ...accepted,
      decisionId: "new-evaluation",
      ...(fresh
        ? {
            evaluation: {
              rowId: row.id,
              previousDecisionId: veto.decisionId,
              audioContentHash: "canonical-row",
              revision: accepted.revision,
              rosterRevision: accepted.rosterRevision,
              profileFingerprint: "current-profile",
            },
          }
        : {}),
    };
    const changed = {
      ...row,
      speakerName: "A",
      speakerIsPlaceholder: false,
      speakerDecision: evidence,
    };
    // Electron transports plain data: a main-process proof handle cannot
    // retain object identity in the renderer.
    f.callbacks.reconsidered = structuredClone({
      rows: [changed],
      assignments: [{ speakerId: "speaker_0", displayName: "A", rows: [changed] }],
    });
    await f.callbacks.MeetingSpeakerEvidenceChanged({
      noteId: NOTE_ID,
      runId: f.store.getActiveRecordingSessionId(),
    });
    assert.equal(f.rows()[0].speakerName, undefined, "response proofs cannot supersede a veto");
    if (fresh) {
      f.callbacks.NoteUpdated(
        structuredClone({
          id: NOTE_ID,
          participants: "[]",
          speaker_roster_revision: 0,
          transcript: JSON.stringify([changed]),
        })
      );
      assert.equal(
        f.rows()[0].speakerName,
        "A",
        "authoritative persistence has already validated the evaluation"
      );
    }
    assert.equal(humanProtected(f.rows()[0]), false);
  });
}
