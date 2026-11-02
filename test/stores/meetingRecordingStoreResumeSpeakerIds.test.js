const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// "Record more" seeds a recording with the note's earlier transcript. Speaker
// ids key the note's names, locks, mappings and embeddings, so the resumed
// session's speakers must never reuse an earlier session's id.

const NOTE_ID = 21;
const START_ARGS = {
  noteId: NOTE_ID,
  noteTitle: "Planning",
  folderId: null,
  autoEndEligible: true,
};

function createElectronAPI({ startResult = {} } = {}) {
  const noopListener = () => () => {};
  const state = { startOptions: [], segmentCallback: null, identifiedCallback: null,
    evidenceCallback: null, reconsidered: null };
  const api = {
    checkSystemAudioAccess: async () => ({
      granted: true,
      status: "granted",
      mode: "native",
      strategy: "native",
    }),
    meetingTranscriptionStart: async (options) => {
      state.startOptions.push(options);
      return {
        success: true,
        systemAudioMode: "native",
        systemAudioStrategy: "native",
        speakerIndexBase: options.speakerIndexBase,
        ...startResult,
      };
    },
    meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
    meetingTranscriptionStop: async () => ({ success: true, diarizationSessionId: null }),
    meetingTranscriptionSend: () => {},
    getNote: async () => null,
    updateNote: async () => ({ success: true }),
    onMeetingDiarizationComplete: noopListener,
    onMeetingTranscriptionSegment: (callback) => {
      state.segmentCallback = callback;
      return () => {
        state.segmentCallback = null;
      };
    },
    onMeetingSpeakerIdentified: (callback) => {
      state.identifiedCallback = callback;
      return () => { state.identifiedCallback = null; };
    },
    onMeetingSpeakerEvidenceChanged: (callback) => {
      state.evidenceCallback = callback;
      return () => { state.evidenceCallback = null; };
    },
    reconsiderLiveSpeakers: async () => state.reconsidered,
    onMeetingSpeakersMerged: noopListener,
    onMeetingSessionSpeakerConfigUpdated: noopListener,
    onMeetingTranscriptionError: noopListener,
    onMeetingTranscriptionFatalError: noopListener,
    onMeetingSystemAudioSilent: noopListener,
  };
  return { api, state };
}

async function loadStore(t, api) {
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, {
    window: { electronAPI: api, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-resume-speaker-ids-test-",
  });
  return vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
}

// Seeded rows end "just now", inside the 8 s carry-forward window, so a
// resumed row would inherit the last seeded speaker if nothing stopped it.
function earlierSession() {
  const now = Date.now();
  return [
    {
      id: "s0",
      text: "let's start",
      source: "system",
      timestamp: now - 2_000,
      speaker: "speaker_0",
      speakerName: "Ada",
      speakerLocked: true,
      speakerIsPlaceholder: false,
    },
    {
      id: "s1",
      text: "agreed",
      source: "system",
      timestamp: now - 1_000,
      speaker: "speaker_1",
      speakerIsPlaceholder: true,
    },
  ];
}

function emitSystemFinal(state, text) {
  state.segmentCallback({ text, source: "system", type: "final", timestamp: Date.now() });
}

const segmentsOf = (store) => store.useMeetingRecordingStore.getState().segments;
const segmentWithText = (store, text) => segmentsOf(store).find((s) => s.text === text);

test("a mic-only live event names mic rows provisionally and leaves system rows alone", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);
  assert.equal(await store.startRecording(START_ARGS), true);
  const now = Date.now();
  state.segmentCallback({ text: "room voice", source: "mic", type: "final", timestamp: now });
  state.segmentCallback({ text: "system voice", source: "system", type: "final", timestamp: now });
  assert.equal(segmentWithText(store, "room voice").speakerName, undefined);
  state.identifiedCallback({ cohort: "mic", speakerId: "speaker_2", displayName: "Alex",
    startTime: now - 100, endTime: now + 100 });
  assert.equal(segmentWithText(store, "room voice").speakerName, "Alex");
  assert.equal(segmentWithText(store, "room voice").speakerStatus, "provisional");
  assert.equal(segmentWithText(store, "system voice").speakerName, undefined);
  store.mergeCommittedSpeakerRows([{ ...segmentWithText(store, "room voice"),
    speakerName: undefined, speakerLocked: true, speakerLockSource: "user" }]);
  state.identifiedCallback({ cohort: "mic", speakerId: "speaker_2", displayName: "Alex",
    startTime: now - 100, endTime: now + 200 });
  assert.equal(segmentWithText(store, "room voice").speakerName, undefined);
  await store.stopRecording();
});

test("newer abstention withdraws an automatic name on a delayed final while an owner lock survives", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);
  assert.equal(await store.startRecording(START_ARGS), true);
  const now = Date.now();
  state.identifiedCallback({ speakerId: "speaker_0", displayName: "Alex", startTime: now - 100, endTime: now + 100 });
  state.segmentCallback({ text: "already named", source: "system", type: "final", timestamp: now });
  assert.equal(segmentWithText(store, "already named").speakerName, "Alex");
  state.identifiedCallback({ speakerId: "speaker_0", uncertainty: { reason: "close_match" },
    startTime: now - 100, endTime: now + 200 });
  assert.equal(segmentWithText(store, "already named").speakerName, undefined);
  assert.equal(segmentWithText(store, "already named").uncertainty?.reason, "close_match");
  state.segmentCallback({ text: "delayed", source: "system", type: "final", timestamp: now });
  assert.equal(segmentWithText(store, "delayed").speakerName, undefined);
  assert.equal(segmentWithText(store, "delayed").uncertainty?.reason, "close_match");
  state.identifiedCallback({ speakerId: "speaker_0", displayName: "Alex", startTime: now - 100,
    endTime: now + 200 });
  assert.equal(store.useMeetingRecordingStore.getState().systemPartialSpeakerName, null);
  state.identifiedCallback({ speakerId: "speaker_0", displayName: "Alex", startTime: now - 100,
    endTime: now + 100 });
  assert.equal(store.useMeetingRecordingStore.getState().systemPartialSpeakerName, null,
    "a late window cannot put stale certainty back in the live partial");
  state.segmentCallback({ text: "later arrival", source: "system", type: "final", timestamp: now });
  assert.equal(segmentWithText(store, "later arrival").speakerName, undefined);
  assert.equal(segmentWithText(store, "later arrival").uncertainty?.reason, "close_match");
  store.assignLiveSpeakerRows(new Set([segmentWithText(store, "already named").id]), "Sam");
  state.identifiedCallback({ speakerId: "speaker_0", displayName: "Casey",
    startTime: now - 100, endTime: now + 250 });
  assert.equal(segmentWithText(store, "already named").speakerName, "Sam");
  store.lockSpeaker("speaker_0", "Owner");
  state.identifiedCallback({ speakerId: "speaker_0", displayName: "Casey", startTime: now - 100, endTime: now + 300 });
  assert.equal(segmentWithText(store, "delayed").speakerName, "Owner");
  await store.stopRecording();
});

test("undo invalidates reconsidered identification windows before a delayed final", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);
  assert.equal(await store.startRecording(START_ARGS), true);
  const now = Date.now();
  state.identifiedCallback({ speakerId: "speaker_0", displayName: "Alex", startTime: now - 100, endTime: now + 100 });
  state.reconsidered = { rows: [{ id: "reconsidered", text: "first", source: "system",
    timestamp: now, speaker: "speaker_0", speakerName: "Sam" }],
    assignments: [{ speakerId: "speaker_0", displayName: "Sam" }] };
  await state.evidenceCallback({ noteId: NOTE_ID, runId: store.getActiveRecordingSessionId() });
  store.restoreSpeakerIdentityCache("speaker_0", null);
  state.segmentCallback({ text: "delayed", source: "system", type: "final", timestamp: now });
  assert.notEqual(segmentWithText(store, "delayed").speakerName, "Sam");
  await store.stopRecording();
});

test("correction and adoption commits invalidate cached identification windows", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);
  assert.equal(await store.startRecording(START_ARGS), true);
  const now = Date.now();
  for (const [label, commit] of [
    ["correction", () => store.assignLiveSpeakerRows(new Set(), null)],
    ["adoption", () => store.mergeCommittedSpeakerRows(segmentsOf(store))],
  ]) {
    state.identifiedCallback({ speakerId: "speaker_0", displayName: "Alex",
      startTime: now - 100, endTime: now + 100 });
    commit();
    state.segmentCallback({ text: label, source: "system", type: "final", timestamp: now });
    assert.notEqual(segmentWithText(store, label).speakerAssessmentAvailable, true,
      `${label} must retire the earlier identification window`);
  }
  await store.stopRecording();
});

test("a fresh meeting numbers its speakers from speaker_0", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(state.startOptions[0].speakerIndexBase, 0);

  emitSystemFinal(state, "hello");
  assert.equal(segmentWithText(store, "hello").speaker, "speaker_0");
  await store.stopRecording();
});

test("a resumed recording gives its speakers ids past the earlier session's", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: earlierSession() }), true);
  assert.equal(state.startOptions[0].speakerIndexBase, 2);

  emitSystemFinal(state, "picking back up");
  const resumed = segmentWithText(store, "picking back up");
  // Two expected speakers cap placeholders at one other voice; that cap counts
  // this session's speakers, so it must not clamp back to speaker_0.
  assert.equal(resumed.speaker, "speaker_2");
  assert.notEqual(resumed.speakerName, "Ada");
  assert.notEqual(resumed.speakerLocked, true);

  const seeded = segmentWithText(store, "let's start");
  assert.equal(seeded.speaker, "speaker_0");
  assert.equal(seeded.speakerName, "Ada");
  await store.stopRecording();
});

test("restart and resume keeps old row ids distinct from a new final", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);
  const { parseSeedSegments } = await import('../../src/utils/parseTranscriptSegments.ts');
  const seeded = parseSeedSegments(JSON.stringify([{ ...earlierSession()[0], id: "seg-1" }]), START_ARGS.noteId);
  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: seeded }), true);
  emitSystemFinal(state, "after restart");
  const rows = segmentsOf(store);
  assert.equal(rows[0].id, seeded[0].id);
  assert.notEqual(rows[0].id, "seg-1");
  assert.match(rows[1].id, /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i);
  assert.equal(new Set(rows.map((s) => s.id)).size, rows.length);
  await store.stopRecording();
  assert.equal(segmentWithText(store, "after restart").id, rows[1].id);
});

test("main can raise the base past ids only the note's stored mappings use", async (t) => {
  const { api, state } = createElectronAPI({ startResult: { speakerIndexBase: 5 } });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: earlierSession() }), true);
  emitSystemFinal(state, "new voice");
  assert.equal(segmentWithText(store, "new voice").speaker, "speaker_5");
  await store.stopRecording();
});

test("a lower base from main never pulls the session back onto earlier ids", async (t) => {
  const { api, state } = createElectronAPI({ startResult: { speakerIndexBase: 0 } });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: earlierSession() }), true);
  emitSystemFinal(state, "new voice");
  assert.equal(segmentWithText(store, "new voice").speaker, "speaker_2");
  await store.stopRecording();
});

test("a 1:1 attendee never confirms the resumed session's first speaker", async (t) => {
  const { api, state } = createElectronAPI({
    startResult: { oneOnOneAttendee: { displayName: "Grace", email: null } },
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: earlierSession() }), true);
  emitSystemFinal(state, "hi again");
  const resumed = segmentWithText(store, "hi again");
  assert.equal(resumed.speaker, "speaker_2");
  assert.equal(resumed.speakerName, undefined);
  assert.notEqual(resumed.speakerStatus, "confirmed");
  assert.equal(segmentWithText(store, "agreed").speakerName, undefined);
  await store.stopRecording();
});

test("resuming twice keeps every session's speaker ids distinct", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: earlierSession() }), true);
  emitSystemFinal(state, "second session");
  await store.stopRecording();
  const afterSecond = segmentsOf(store);
  assert.equal(segmentWithText(store, "second session").speaker, "speaker_2");

  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: afterSecond }), true);
  assert.equal(state.startOptions[1].speakerIndexBase, 3);
  emitSystemFinal(state, "third session");
  assert.equal(segmentWithText(store, "third session").speaker, "speaker_3");
  assert.equal(segmentWithText(store, "second session").speaker, "speaker_2");
  await store.stopRecording();
});

test("renaming a speaker during a resumed recording touches only that session's rows", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: earlierSession() }), true);
  emitSystemFinal(state, "new voice");
  const newSpeaker = segmentWithText(store, "new voice").speaker;

  store.lockSpeaker(newSpeaker, "Bob");
  assert.equal(segmentWithText(store, "new voice").speakerName, "Bob");
  assert.equal(segmentWithText(store, "let's start").speakerName, "Ada");
  assert.equal(segmentWithText(store, "agreed").speakerName, undefined);
  assert.notEqual(segmentWithText(store, "agreed").speakerLocked, true);

  // Renaming an earlier session's speaker leaves the new voice alone.
  store.lockSpeaker("speaker_1", "Carol");
  assert.equal(segmentWithText(store, "agreed").speakerName, "Carol");
  assert.equal(segmentWithText(store, "new voice").speakerName, "Bob");

  // Later rows from the renamed voice keep its lock.
  emitSystemFinal(state, "still me");
  assert.equal(segmentWithText(store, "still me").speaker, newSpeaker);
  assert.equal(segmentWithText(store, "still me").speakerName, "Bob");
  await store.stopRecording();
});

test("recording into a teammate's note preserves the new recorder across save and generation", async (t) => {
  const { api, state } = createElectronAPI();
  const writes = [];
  api.updateNote = async (_id, patch) => {
    writes.push(patch);
    return { success: true };
  };
  const store = await loadStore(t, api);
  const seed = [
    { id: "old", source: "mic", speaker: "you", text: "Alice's earlier words", timestamp: 1 },
  ];
  await store.startRecording({ ...START_ARGS, seedSegments: seed, recorderName: "Bob Viewer" });
  state.segmentCallback({
    text: "Bob's new words",
    source: "mic",
    type: "final",
    timestamp: Date.now(),
  });
  await store.stopRecording();
  const { parseTranscriptSegments } = await import("../../src/utils/parseTranscriptSegments.ts");
  const { buildLlmTranscript } = await import("../../src/utils/llmTranscript.ts");
  const segments = parseTranscriptSegments(writes.at(-1).transcript);
  assert.equal(segments[0].recorderName, undefined);
  assert.equal(segments[1].recorderName, "Bob Viewer");
  assert.equal(
    buildLlmTranscript(segments, {}, "Alice Owner", (key) => key),
    "Alice Owner: Alice's earlier words\nBob Viewer: Bob's new words"
  );
});
