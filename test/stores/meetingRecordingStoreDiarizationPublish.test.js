const test = require("node:test");
const assert = require("node:assert/strict");
const { deferred } = require("../helpers/harness/deferred");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// Delayed diarization is always persisted to the note that owns its session.
// Publishing it to the UI is separate, and must not happen while a recording is
// still appending to that same note: the editor prefers a published overlay to
// the note's own text, so the live half would look like it had vanished.

const NOTE_ID = 11;
const START_ARGS = { noteId: NOTE_ID, noteTitle: "Standup", folderId: null, autoEndEligible: true };

function createElectronAPI({ stopDiarizationSessionId = null } = {}) {
  const noopListener = () => () => {};
  const state = {
    diarizationCallback: null,
    segmentCallback: null,
    errorCallback: null,
    updatedTranscripts: [],
    stopDiarizationSessionId,
    stopTranscript: "",
    // Runs inside meetingTranscriptionStop, before its reply, like main's
    // synchronous skip-diarization send.
    onStop: null,
  };
  const notes = new Map([
    [
      NOTE_ID,
      {
        id: NOTE_ID,
        participants: "[]",
        speaker_roster_revision: 0,
        transcript: "",
        deleted_at: null,
      },
    ],
  ]);
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
    meetingTranscriptionStop: async () => {
      state.onStop?.(state.stopDiarizationSessionId);
      return {
        success: true,
        diarizationSessionId: state.stopDiarizationSessionId,
        transcript: state.stopTranscript,
      };
    },
    meetingTranscriptionSend: () => {},
    getNote: async (id) => notes.get(id) ?? null,
    updateNote: async (id, patch) => {
      state.updatedTranscripts.push({ id, transcript: patch.transcript });
      const note = notes.get(id);
      if (note) note.transcript = patch.transcript;
      return { success: true };
    },
    saveNoteSpeakerEmbeddings: async () => ({ success: true }),
    onMeetingDiarizationComplete: (callback) => {
      state.diarizationCallback = callback;
      return () => {
        state.diarizationCallback = null;
      };
    },
    onMeetingTranscriptionSegment: (callback) => {
      state.segmentCallback = callback;
      return () => {
        state.segmentCallback = null;
      };
    },
    onMeetingSpeakerIdentified: noopListener,
    onMeetingSpeakersMerged: noopListener,
    onMeetingSessionSpeakerConfigUpdated: noopListener,
    onMeetingTranscriptionError: (callback) => {
      state.errorCallback = callback;
      return () => {
        state.errorCallback = null;
      };
    },
    onMeetingTranscriptionFatalError: noopListener,
    onMeetingSystemAudioSilent: noopListener,
  };
  return { api, state, notes };
}

async function loadModules(t, api) {
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, {
    window: { electronAPI: api, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-diarization-publish-test-",
  });
  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { parseTranscriptSegments, parseSeedSegments } = await vite.ssrLoadModule(
    "/utils/parseTranscriptSegments.ts"
  );
  return { store, parseTranscriptSegments, parseSeedSegments };
}

async function loadStore(t, api) {
  return (await loadModules(t, api)).store;
}

const ENRICHED = [{ id: "d0", text: "hello there", speaker: "speaker_0", speakerName: "Ada" }];

// The serial queue behind the listener awaits getNote and updateNote.
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

test("a finished session's diarization is not published over the recording that resumed its note", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);
  assert.equal(typeof state.diarizationCallback, "function");

  assert.equal(await store.startRecording(START_ARGS), true);
  state.updatedTranscripts.length = 0;

  state.diarizationCallback({
    noteId: NOTE_ID,
    sessionId: "diar-before-restart",
    segments: ENRICHED,
  });
  await settle();

  assert.equal(
    store.useMeetingRecordingStore.getState().completedDiarization,
    null,
    "the finished half must not paint over the live recording"
  );
  // Suppressing the overlay must not cost the enrichment its write.
  assert.equal(state.updatedTranscripts.length, 1);
  assert.match(state.updatedTranscripts[0].transcript, /Ada/);

  await store.stopRecording();
});

test("the same result publishes normally once the recording has stopped", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  await store.stopRecording();

  state.diarizationCallback({
    noteId: NOTE_ID,
    sessionId: "diar-after-stop",
    segments: ENRICHED,
  });
  await settle();

  const published = store.useMeetingRecordingStore.getState().completedDiarization;
  assert.equal(published?.noteId, NOTE_ID);
  assert.equal(published?.segments.length, 1);
  assert.equal(
    JSON.parse(state.updatedTranscripts.at(-1).transcript).rows[0].finalAnalysisCompleted,
    true
  );
});

test("a live recording on another note does not suppress the publish", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording({ ...START_ARGS, noteId: 99 }), true);

  state.diarizationCallback({
    noteId: NOTE_ID,
    sessionId: "diar-other-note",
    segments: ENRICHED,
  });
  await settle();

  assert.equal(store.useMeetingRecordingStore.getState().completedDiarization?.noteId, NOTE_ID);
  await store.stopRecording();
});

// A resumed note seeds the recording with its earlier transcript, but the
// diarization result covers only the resumed session's audio. A repeated line
// must enrich the resumed session's row, never the earlier session's twin.
test("a resumed note's diarization labels the resumed session's row, not an earlier one with the same text", async (t) => {
  const { api, state } = createElectronAPI({ stopDiarizationSessionId: "diar-resumed" });
  const store = await loadStore(t, api);

  const earlierSession = [
    {
      id: "stored-0",
      text: "Can everyone hear me?",
      source: "system",
      timestamp: 1.0,
      speaker: "speaker_0",
      speakerName: "Bob",
      speakerIsPlaceholder: false,
      speakerStatus: "confirmed",
    },
    {
      id: "stored-1",
      text: "Yeah.",
      source: "system",
      timestamp: 4.2,
      speaker: "speaker_1",
      speakerName: "Carol",
      speakerIsPlaceholder: false,
      speakerStatus: "confirmed",
    },
  ];
  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: earlierSession }), true);
  state.segmentCallback({
    type: "final",
    source: "system",
    text: "Yeah.",
    timestamp: 1760000003000,
  });
  await store.stopRecording();

  state.diarizationCallback({
    noteId: NOTE_ID,
    sessionId: "diar-resumed",
    segments: [
      {
        text: "Yeah.",
        source: "system",
        timestamp: 3.0,
        speaker: "speaker_0",
        speakerName: "Dave",
        speakerIsPlaceholder: false,
        speakerStatus: "confirmed",
      },
    ],
  });
  await settle();

  const rows = require("../../src/helpers/transcriptDocument").readTranscriptDocument(
    state.updatedTranscripts.at(-1).transcript
  ).rows;
  assert.deepEqual(
    rows.map((row) => [row.text, row.timestamp, row.speakerName]),
    [
      ["Can everyone hear me?", 1.0, "Bob"],
      ["Yeah.", 4.2, "Carol"],
      ["Yeah.", 3.0, "Dave"],
    ]
  );
});

test("a policy stop's early diarization waits for the resumed session's stop result and persistence", async (t) => {
  const { api, state, notes } = createElectronAPI({ stopDiarizationSessionId: "diar-policy" });
  const { store, parseTranscriptSegments } = await loadModules(t, api);
  const note = notes.get(NOTE_ID);
  note.transcript = JSON.stringify([diarized("Yeah.", 1.0, "Carol")]);
  const reply = deferred();
  const stop = api.meetingTranscriptionStop;
  api.meetingTranscriptionStop = async () => {
    await reply.promise;
    return stop();
  };
  t.after(() => reply.resolve());
  assert.equal(
    await store.startRecording({
      ...START_ARGS,
      seedSegments: parseTranscriptSegments(note.transcript),
    }),
    true
  );
  state.segmentCallback({
    type: "final",
    source: "system",
    text: "Yeah.",
    timestamp: 1760000100000,
  });

  state.errorCallback("policyRestricted");
  state.diarizationCallback({
    noteId: NOTE_ID,
    sessionId: "diar-policy",
    segments: [diarized("Yeah.", 2.0, "Dave")],
  });
  await settle();
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
  assert.deepEqual(rowsOf(note)[0], ["Yeah.", 1.0, "Carol"]);
  assert.equal(rowsOf(note).length, 2);

  const finished = store.stopRecording();
  reply.resolve();
  await finished;
  await settle();
  assert.deepEqual(rowsOf(note), [
    ["Yeah.", 1.0, "Carol"],
    ["Yeah.", 2.0, "Dave"],
  ]);
});

test("main ending the recording for an account change stops it with its own reason", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);
  assert.equal(await store.startRecording(START_ARGS), true);

  state.errorCallback("accountChanged");
  await settle();
  const { isRecording, error } = store.useMeetingRecordingStore.getState();
  assert.equal(isRecording, false);
  assert.equal(error, "accountChanged");
});

const diarized = (text, timestamp, speakerName) => ({
  text,
  source: "system",
  timestamp,
  speaker: "speaker_0",
  speakerName,
  speakerIsPlaceholder: false,
  speakerStatus: "confirmed",
});

const rowsOf = (note) =>
  require("../../src/helpers/transcriptDocument")
    .readTranscriptDocument(note.transcript)
    .rows.map((row) => [row.text, row.timestamp, row.speakerName]);

// Each stop keeps its own seed length: with one shared value, the resumed
// session's seed would also shield the earlier session's own diarization.
test("an earlier session's diarization that lands after the note was resumed still labels its rows", async (t) => {
  const { api, state, notes } = createElectronAPI();
  const { store, parseTranscriptSegments } = await loadModules(t, api);
  const note = notes.get(NOTE_ID);

  state.stopDiarizationSessionId = "diar-1";
  assert.equal(await store.startRecording(START_ARGS), true);
  state.segmentCallback({
    type: "final",
    source: "system",
    text: "Yeah.",
    timestamp: 1760000001000,
  });
  await store.stopRecording();

  state.stopDiarizationSessionId = "diar-2";
  const seedSegments = parseTranscriptSegments(note.transcript);
  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments }), true);
  state.segmentCallback({
    type: "final",
    source: "system",
    text: "Yeah.",
    timestamp: 1760000100000,
  });
  await store.stopRecording();

  state.diarizationCallback({
    noteId: NOTE_ID,
    sessionId: "diar-1",
    segments: [diarized("Yeah.", 1.0, "Carol")],
  });
  await settle();
  state.diarizationCallback({
    noteId: NOTE_ID,
    sessionId: "diar-2",
    segments: [diarized("Yeah.", 2.0, "Dave")],
  });
  await settle();

  assert.deepEqual(rowsOf(note), [
    ["Yeah.", 1.0, "Carol"],
    ["Yeah.", 2.0, "Dave"],
  ]);
});

// An earlier session's result that removes rows after the note was resumed
// must not leave the resumed session's seed covering its own first row, even
// when it lands while the resumed session's stop call is still running.
for (const duringStop of [false, true]) {
  test(`rows an earlier session's diarization removes don't shift a resumed session's seed${duringStop ? " (mid-stop)" : ""}`, async (t) => {
    const { api, state, notes } = createElectronAPI();
    const { store, parseTranscriptSegments } = await loadModules(t, api);
    const note = notes.get(NOTE_ID);
    const echo = { text: "Yeah.", source: "mic", timestamp: 1760000001500 };

    state.stopDiarizationSessionId = "diar-1";
    assert.equal(await store.startRecording(START_ARGS), true);
    state.segmentCallback({
      type: "final",
      source: "system",
      text: "Yeah.",
      timestamp: 1760000001000,
    });
    state.segmentCallback({ type: "final", ...echo });
    await store.stopRecording();

    state.stopDiarizationSessionId = "diar-2";
    const seedSegments = parseTranscriptSegments(note.transcript);
    assert.equal(await store.startRecording({ ...START_ARGS, seedSegments }), true);
    state.segmentCallback({
      type: "final",
      source: "system",
      text: "Sure, go ahead.",
      timestamp: 1760000100000,
    });
    const earlierResult = async () => {
      state.diarizationCallback({
        noteId: NOTE_ID,
        sessionId: "diar-1",
        segments: [diarized("Yeah.", 1.0, "Carol")],
        removedSegments: [echo],
      });
      await settle();
    };
    if (duringStop) {
      const stop = api.meetingTranscriptionStop;
      api.meetingTranscriptionStop = async () => {
        await earlierResult();
        return stop();
      };
    }
    await store.stopRecording();
    if (!duringStop) await earlierResult();

    state.diarizationCallback({
      noteId: NOTE_ID,
      sessionId: "diar-2",
      segments: [diarized("Sure, go ahead.", 2.0, "Dave")],
    });
    await settle();

    assert.deepEqual(rowsOf(note), [
      ["Yeah.", 1.0, "Carol"],
      ["Sure, go ahead.", 2.0, "Dave"],
    ]);
  });
}

// Main sends a skipped diarization before the stop call returns, so the
// listener must read the seed length only after its getNote round trip.
test("a skipped diarization sent before stop returns still leaves the seeded rows alone", async (t) => {
  const { api, state, notes } = createElectronAPI({ stopDiarizationSessionId: "diar-skipped" });
  const { store, parseTranscriptSegments } = await loadModules(t, api);
  const note = notes.get(NOTE_ID);
  note.transcript = JSON.stringify([diarized("Yeah.", 1.0, "Carol")]);

  state.onStop = (sessionId) =>
    state.diarizationCallback({
      noteId: NOTE_ID,
      sessionId,
      segments: [{ id: "segment-0", text: "Yeah.", source: "system", timestamp: 1760000100001 }],
    });
  const seedSegments = parseTranscriptSegments(note.transcript);
  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments }), true);
  state.segmentCallback({
    type: "final",
    source: "system",
    text: "Yeah.",
    timestamp: 1760000100000,
  });
  await store.stopRecording();
  await settle();

  assert.deepEqual(rowsOf(note)[0], ["Yeah.", 1.0, "Carol"]);
});

for (const completionTiming of ["while recording", "during stop", "after stop"]) {
  test(`a stop-only transcript is replaced once on a resumed session's earlier completion (${completionTiming})`, async (t) => {
    const { api, state, notes } = createElectronAPI();
    const { store, parseSeedSegments } = await loadModules(t, api);
    const note = notes.get(NOTE_ID);
    state.stopDiarizationSessionId = "diar-first";
    state.stopTranscript = "First sentence. Second sentence.";
    assert.equal(await store.startRecording(START_ARGS), true);
    await store.stopRecording();

    state.stopDiarizationSessionId = "diar-resumed";
    state.stopTranscript = completionTiming === "during stop" ? "New session." : "";
    assert.equal(
      await store.startRecording({
        ...START_ARGS,
        seedSegments: parseSeedSegments(note.transcript),
      }),
      true
    );
    if (completionTiming !== "during stop") {
      state.segmentCallback({
        type: "final",
        source: "system",
        text: "New session.",
        timestamp: 1760000100000,
      });
    }
    const earlierCompletion = async () => {
      state.diarizationCallback({
        noteId: NOTE_ID,
        sessionId: "diar-first",
        segments: [
          diarized("First sentence.", 1.0, "Carol"),
          diarized("Second sentence.", 2.0, "Carol"),
        ],
      });
      await settle();
    };

    if (completionTiming === "while recording") {
      await earlierCompletion();
      await store.persistLiveTranscript();
    } else if (completionTiming === "during stop") {
      const stop = api.meetingTranscriptionStop;
      api.meetingTranscriptionStop = async () => {
        await earlierCompletion();
        return stop();
      };
    }
    await store.stopRecording();
    if (completionTiming === "after stop") await earlierCompletion();

    state.diarizationCallback({
      noteId: NOTE_ID,
      sessionId: "diar-resumed",
      segments: [diarized("New session.", 3.0, "Dave")],
    });
    await settle();

    assert.deepEqual(rowsOf(note), [
      ["First sentence.", 1.0, "Carol"],
      ["Second sentence.", 2.0, "Carol"],
      ["New session.", 3.0, "Dave"],
    ]);
  });
}

test("late diarization names the session recorder even when no live row arrived", async (t) => {
  const { api, state, notes } = createElectronAPI({ stopDiarizationSessionId: "bobs-session" });
  state.stopTranscript = "Bob's words";
  const { store, parseTranscriptSegments } = await loadModules(t, api);
  await store.startRecording({ ...START_ARGS, recorderName: "Bob Viewer" });
  await store.stopRecording();
  state.diarizationCallback({
    noteId: NOTE_ID,
    sessionId: "bobs-session",
    segments: [{ source: "mic", speaker: "you", text: "Bob's words", timestamp: 1 }],
  });
  await settle();
  const segments = parseTranscriptSegments(notes.get(NOTE_ID).transcript);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].recorderName, "Bob Viewer");
});

test("a self correction during resumed recording leaves earlier recorders alone", async (t) => {
  const { api } = createElectronAPI();
  const store = await loadStore(t, api);
  await store.startRecording({
    ...START_ARGS,
    recorderName: "Bob Viewer",
    seedSegments: [
      {
        id: "alice",
        source: "mic",
        speaker: "you",
        text: "Alice",
        speakerName: "Alice Owner",
        speakerLocked: true,
      },
      { id: "bob", source: "mic", speaker: "you", text: "Bob", recorderName: "Bob Viewer" },
    ],
  });
  store.lockSpeaker("you", "Bob Corrected", "Bob Viewer");
  const segments = store.useMeetingRecordingStore.getState().segments;
  assert.equal(segments[0].speakerName, "Alice Owner");
  assert.equal(segments[1].speakerName, "Bob Corrected");
  await store.stopRecording();
});

test("ordinary rejection stays local and does not retire an unchanged roster revision", async (t) => {
  const { api, state } = createElectronAPI();
  let onNoteUpdated, onSpeaker;
  api.onNoteUpdated = (cb) => {
    onNoteUpdated = cb;
    return () => {};
  };
  api.onMeetingSpeakerIdentified = (cb) => {
    onSpeaker = cb;
    return () => {};
  };
  const store = await loadStore(t, api);
  assert.equal(await store.startRecording(START_ARGS), true);
  const now = Date.now();
  const accepted = {
    candidateSetStatus: "recorded",
    noteId: NOTE_ID,
    source: "note",
    revision: "unchanged",
    rawRoster: "[]",
    roster: [],
    eligibleProfileIds: [1],
    acceptedProfileId: 1,
    rejectionReason: null,
    rosterRevision: 0,
    linkedEventId: null,
  };
  const rejected = { ...accepted, acceptedProfileId: null, rejectionReason: "acoustic_rejected" };
  state.segmentCallback({ text: "unclear", source: "system", timestamp: now });
  onSpeaker({
    cohort: "system",
    speakerId: "speaker_0",
    displayName: null,
    startTime: now - 100,
    endTime: now + 100,
    speakerDecision: rejected,
  });
  const row = store.useMeetingRecordingStore.getState().segments.at(-1);
  onNoteUpdated({
    id: NOTE_ID,
    participants: "[]",
    speaker_roster_revision: 0,
    transcript: JSON.stringify([row]),
  });
  assert.equal(
    store.useMeetingRecordingStore.getState().segments[0].speakerDecision.rejectionReason,
    "acoustic_rejected"
  );
  state.segmentCallback({ text: "clear", source: "system", timestamp: now + 1000 });
  onSpeaker({
    cohort: "system",
    speakerId: "speaker_1",
    displayName: "A",
    startTime: now + 900,
    endTime: now + 1100,
    speakerDecision: accepted,
  });
  assert.equal(store.useMeetingRecordingStore.getState().segments.at(-1).speakerName, "A");
  await store.stopRecording();
});

test("an unsafe saved row preserves an accepted sibling and its identity caches", async (t) => {
  let store;
  t.after(() => store?.stopRecording());
  const { api, state } = createElectronAPI();
  let onNoteUpdated, onSpeaker;
  api.onNoteUpdated = (callback) => {
    onNoteUpdated = callback;
    return () => {};
  };
  api.onMeetingSpeakerIdentified = (callback) => {
    onSpeaker = callback;
    return () => {};
  };
  store = await loadStore(t, api);
  assert.equal(await store.startRecording(START_ARGS), true);
  const now = Date.now();
  const accepted = {
    candidateSetStatus: "recorded",
    noteId: NOTE_ID,
    source: "note",
    revision: "unchanged",
    rawRoster: "[]",
    roster: [],
    eligibleProfileIds: [1],
    acceptedProfileId: 1,
    acceptedIdentity: { email: "a@example.com" },
    rejectionReason: null,
    rosterRevision: 0,
    linkedEventId: null,
  };
  state.segmentCallback({ text: "unsafe", source: "system", timestamp: now });
  state.segmentCallback({ text: "clear sibling", source: "system", timestamp: now + 1000 });
  onSpeaker({
    cohort: "system",
    speakerId: "speaker_0",
    displayName: "A",
    startTime: now - 100,
    endTime: now + 5000,
    speakerDecision: accepted,
  });
  const [unsafe, sibling] = store.useMeetingRecordingStore.getState().segments;
  assert.equal(sibling.speakerName, "A");
  const rejected = {
    ...unsafe,
    speakerName: undefined,
    speakerIsPlaceholder: true,
    uncertainty: { reason: "too_short" },
    speakerDecision: {
      ...accepted,
      acceptedProfileId: null,
      acceptedIdentity: null,
      rejectionReason: "unsafe_span",
    },
  };
  // The accepted sibling has not been saved yet; it shares only the cluster.
  onNoteUpdated({
    id: NOTE_ID,
    participants: "[]",
    speaker_roster_revision: 0,
    transcript: JSON.stringify([rejected]),
  });
  const rows = store.useMeetingRecordingStore.getState().segments;
  assert.equal(
    rows.find((row) => row.id === unsafe.id).speakerDecision.rejectionReason,
    "unsafe_span"
  );
  assert.equal(rows.find((row) => row.id === sibling.id).speakerName, "A");
  assert.deepEqual(rows.find((row) => row.id === sibling.id).speakerDecision, accepted);
  assert.equal(store.useMeetingRecordingStore.getState().systemPartialSpeakerName, "A");
  state.segmentCallback({ text: "still clear", source: "system", timestamp: now + 2000 });
  const cached = store.useMeetingRecordingStore.getState().segments.at(-1);
  assert.equal(cached.speakerName, "A");
  assert.deepEqual(cached.speakerDecision, accepted);
});

test("live identification and merge names require automatic evidence on unprotected rows", async (t) => {
  const { api, state } = createElectronAPI();
  let onSpeaker, onMerge, onEvidence;
  api.onMeetingSpeakerIdentified = (cb) => {
    onSpeaker = cb;
    return () => {};
  };
  api.onMeetingSpeakersMerged = (cb) => {
    onMerge = cb;
    return () => {};
  };
  api.onMeetingSpeakerEvidenceChanged = (cb) => {
    onEvidence = cb;
    return () => {};
  };
  const store = await loadStore(t, api);
  assert.equal(await store.startRecording(START_ARGS), true);
  const now = Date.now();
  state.segmentCallback({ text: "hello", source: "system", timestamp: now });
  onSpeaker({
    cohort: "system",
    speakerId: "speaker_1",
    displayName: "Outsider",
    startTime: now - 100,
    endTime: now + 100,
  });
  assert.equal(store.useMeetingRecordingStore.getState().segments[0].speakerName, undefined);
  const locked = {
    id: "locked",
    text: "corrected",
    source: "system",
    speaker: "speaker_1",
    speakerName: "Human outsider",
    speakerLocked: true,
  };
  store.useMeetingRecordingStore.setState({
    segments: [...store.useMeetingRecordingStore.getState().segments, locked],
  });
  onMerge([{ keep: "speaker_0", remove: "speaker_1", displayName: "Outsider", similarity: 0.99 }]);
  assert.equal(store.useMeetingRecordingStore.getState().segments[0].speakerName, undefined);
  assert.deepEqual(store.useMeetingRecordingStore.getState().segments[1], locked);
  const unproven = {
    ...store.useMeetingRecordingStore.getState().segments[0],
    speakerName: "Outsider",
    speakerDecision: undefined,
  };
  api.reconsiderLiveSpeakers = async () => ({
    rows: [unproven],
    assignments: [{ speakerId: "speaker_0", displayName: "Outsider", rows: [unproven] }],
  });
  await onEvidence({ noteId: NOTE_ID, runId: store.getActiveRecordingSessionId() });
  assert.equal(store.useMeetingRecordingStore.getState().segments[0].speakerName, undefined);
  assert.deepEqual(store.useMeetingRecordingStore.getState().segments[1], locked);
  await store.stopRecording();
});

test("roster edit retires cached identifications and rejects delayed live names", async (t) => {
  const { api, state, notes } = createElectronAPI();
  notes.get(NOTE_ID).participants = '[{"email":"c@example.com"}]';
  notes.get(NOTE_ID).speaker_roster_revision = 1;
  let onNoteUpdated, onSpeaker;
  api.onNoteUpdated = (callback) => {
    onNoteUpdated = callback;
    return () => {};
  };
  api.onMeetingSpeakerIdentified = (callback) => {
    onSpeaker = callback;
    return () => {};
  };
  const store = await loadStore(t, api);
  assert.equal(await store.startRecording(START_ARGS), true);
  const now = Date.now();
  const decision = {
    candidateSetStatus: "recorded",
    noteId: NOTE_ID,
    source: "note",
    revision: JSON.stringify([
      1,
      "note",
      '[{"email":"c@example.com"}]',
      null,
      [[3, "c@example.com"]],
    ]),
    rawRoster: '[{"email":"c@example.com"}]',
    roster: [{ email: "c@example.com" }],
    eligibleProfileIds: [3],
    acceptedProfileId: 3,
    rejectionReason: null,
    rosterRevision: 1,
    linkedEventId: null,
  };
  state.segmentCallback({ text: "hello", source: "system", timestamp: now });
  onSpeaker({
    cohort: "system",
    speakerId: "speaker_0",
    displayName: "C",
    startTime: now - 100,
    endTime: now + 100,
    speakerDecision: decision,
  });
  assert.equal(store.useMeetingRecordingStore.getState().segments.at(-1).speakerName, "C");
  onNoteUpdated?.({
    id: NOTE_ID,
    participants: '[{"email":"a@example.com"}]',
    speaker_roster_revision: 2,
    transcript: "[]",
  });
  onSpeaker({
    cohort: "system",
    speakerId: "speaker_0",
    displayName: "C",
    startTime: now - 100,
    endTime: now + 200,
    speakerDecision: decision,
  });
  assert.equal(store.useMeetingRecordingStore.getState().segments.at(-1).speakerName, undefined);
  assert.equal(store.useMeetingRecordingStore.getState().systemPartialSpeakerName, null);
  await store.stopRecording();
});

test("roster late reconsideration and merge replies cannot restore a withdrawn live name", async (t) => {
  const { api, state } = createElectronAPI();
  let onNoteUpdated, onSpeaker, onEvidence, onMerge, runId;
  api.onNoteUpdated = (cb) => {
    onNoteUpdated = cb;
    return () => {};
  };
  api.onMeetingSpeakerIdentified = (cb) => {
    onSpeaker = cb;
    return () => {};
  };
  api.onMeetingSpeakerEvidenceChanged = (cb) => {
    onEvidence = cb;
    return () => {};
  };
  api.onMeetingSpeakersMerged = (cb) => {
    onMerge = cb;
    return () => {};
  };
  api.meetingTranscriptionStart = async (opts) => {
    runId = opts.sessionId;
    return { success: true, systemAudioMode: "native", systemAudioStrategy: "native" };
  };
  const gate = deferred();
  api.reconsiderLiveSpeakers = () => gate.promise;
  const store = await loadStore(t, api);
  assert.equal(await store.startRecording(START_ARGS), true);
  const now = Date.now();
  const d = {
    candidateSetStatus: "recorded",
    noteId: NOTE_ID,
    source: "note",
    revision: "old",
    rawRoster: '[{"email":"c@example.com"}]',
    roster: [],
    eligibleProfileIds: [3],
    acceptedProfileId: 3,
    rejectionReason: null,
    rosterRevision: 1,
    linkedEventId: null,
  };
  state.segmentCallback({ text: "hello", source: "system", timestamp: now });
  onSpeaker({
    cohort: "system",
    speakerId: "speaker_0",
    displayName: "C",
    startTime: now - 100,
    endTime: now + 100,
    speakerDecision: d,
  });
  const oldRow = { ...store.useMeetingRecordingStore.getState().segments.at(-1) };
  const pending = onEvidence({ noteId: NOTE_ID, runId });
  onNoteUpdated?.({
    id: NOTE_ID,
    participants: '[{"email":"a@example.com"}]',
    speaker_roster_revision: 2,
    transcript: "[]",
  });
  gate.resolve({
    assignments: [{ speakerId: "speaker_0", displayName: "C", rows: [oldRow] }],
    rows: [oldRow],
  });
  await pending;
  assert.equal(store.useMeetingRecordingStore.getState().segments.at(-1).speakerName, undefined);
  onMerge([
    { keep: "speaker_1", remove: "speaker_0", displayName: "C", speakerDecision: d, similarity: 1 },
  ]);
  assert.equal(store.useMeetingRecordingStore.getState().segments.at(-1).speakerName, undefined);
  assert.equal(store.useMeetingRecordingStore.getState().systemPartialSpeakerName, null);
  await store.stopRecording();
});

for (const cause of ["cached final", "diarization_skipped", "diarization_failed"]) {
  test(`${cause} cannot reaccept an identical vetoed row at completion`, async (t) => {
    const { api, state, notes } = createElectronAPI();
    await loadStore(t, api);
    const decision = {
      decisionId: "veto",
      noteId: NOTE_ID,
      revision: "r",
      source: "none",
      rawRoster: null,
      rosterRevision: 0,
      eligibleProfileIds: [1],
      acceptedProfileId: null,
      rejectionReason: "no_match",
    };
    const row = {
      id: "cd3ea3ab-a9a8-4f78-a4b2-8b90ef90bdb9",
      text: "hello",
      source: "system",
      speaker: "speaker_0",
      speakerIsPlaceholder: true,
      speakerDecision: decision,
      audioSpan: { recordingId: 1, trackId: "system", startSample: 0, endSample: 96000 },
    };
    notes.get(NOTE_ID).transcript = JSON.stringify([row]);
    state.diarizationCallback({
      noteId: NOTE_ID,
      sessionId: "late",
      centroidPersistence: { cause },
      segments: [
        {
          ...row,
          speakerName: "A",
          speakerIsPlaceholder: false,
          speakerDecision: {
            ...decision,
            decisionId: "cached",
            acceptedProfileId: 1,
            rejectionReason: null,
          },
        },
      ],
    });
    await settle();
    const actual = JSON.parse(notes.get(NOTE_ID).transcript).rows[0];
    assert.equal(actual.speakerName, undefined);
    assert.equal(actual.speakerDecision.rejectionReason, "no_match");
  });
}

test("run6: a 2000-row completion retry parses its base once", async (t) => {
  const { api, state, notes } = createElectronAPI();
  const { store } = await loadModules(t, api);
  const rows = Array.from({ length: 2000 }, (_, i) => ({
    id: `perf-${i}`,
    text: `line ${i}`,
    source: "system",
    timestamp: i,
    speaker: "speaker_0",
  }));
  notes.get(NOTE_ID).transcript = JSON.stringify({ version: 2, rows });
  let attempts = 0;
  const done = deferred();
  api.updateNote = async (_id, patch) => {
    if (++attempts === 1) return { success: false, error: "transcript_changed" };
    notes.get(NOTE_ID).transcript = patch.transcript;
    done.resolve();
    return { success: true };
  };
  let parses = 0;
  let transcriptParses = 0;
  const parse = JSON.parse;
  t.mock.method(JSON, "parse", (...args) => {
    parses++;
    if (typeof args[0] === "string" && args[0].includes("perf-1999")) transcriptParses++;
    return parse(...args);
  });
  const start = performance.now();
  state.diarizationCallback({ noteId: NOTE_ID, sessionId: "perf", segments: rows });
  await done.promise;
  const elapsed = performance.now() - start;
  console.log(
    `RUN6_RETRY rows=2000 ms=${elapsed.toFixed(1)} parses=${parses} transcriptParses=${transcriptParses}`
  );
  assert.equal(attempts, 2);
  const output = JSON.parse(notes.get(NOTE_ID).transcript).rows;
  assert.equal(output.length, 2000);
  assert.equal(new Set(output.map((row) => row.text)).size, 2000);
  assert.ok(parses < 100, `JSON parses: ${parses} (${transcriptParses} transcript parses)`);
  assert.ok(elapsed < 2500, `retry took ${elapsed}ms`);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
});

test("run6: recording seed resolves the current declared roster", async (t) => {
  const { api, notes } = createElectronAPI();
  notes.get(NOTE_ID).participants = '[{"email":"a@example.com"}]';
  const store = await loadStore(t, api);
  await store.startRecording({
    ...START_ARGS,
    seedSegments: [{ id: "seed", text: "hello", source: "system", speakerName: "Outsider" }],
  });
  const row = store.useMeetingRecordingStore.getState().segments[0];
  assert.equal(row.speakerName, undefined);
  assert.equal(row.speakerDecision.rejectionReason, "legacy_not_evaluated");
  await store.stopRecording();
});

for (const timing of ["before read", "during commit"])
  test(`run6: resumed-recording completion resolves current scope for its live installation (${timing})`, async (t) => {
    const { api, state, notes } = createElectronAPI({ stopDiarizationSessionId: "first" });
    let noteUpdated;
    api.onNoteUpdated = (callback) => {
      noteUpdated = callback;
      return () => {};
    };
    api.getNote = async (id) => ({ ...notes.get(id) });
    const { store, parseSeedSegments } = await loadModules(t, api);
    state.stopTranscript = "First sentence.";
    await store.startRecording(START_ARGS);
    await store.stopRecording();
    state.stopTranscript = "";
    await store.startRecording({
      ...START_ARGS,
      seedSegments: parseSeedSegments(notes.get(NOTE_ID).transcript),
    });
    const note = notes.get(NOTE_ID);
    const changeRoster = () => {
      note.participants = '[{"email":"other@example.com"}]';
      note.speaker_roster_revision = 1;
    };
    if (timing === "before read") changeRoster();
    else {
      const update = api.updateNote;
      let edited = false;
      api.updateNote = async (id, patch, options) => {
        const result = await update(id, patch);
        const snapshot = { ...notes.get(id) };
        if (!edited && options?.reconcileTranscript) {
          edited = true;
          changeRoster();
          noteUpdated({ ...note });
        }
        return { ...result, note: snapshot };
      };
    }
    const d = {
      candidateSetStatus: "recorded",
      decisionId: "old-acceptance",
      noteId: NOTE_ID,
      source: "note",
      rawRoster: "[]",
      rosterRevision: 0,
      acceptedProfileId: 1,
      eligibleProfileIds: [1],
      rejectionReason: null,
    };
    state.diarizationCallback({
      noteId: NOTE_ID,
      sessionId: "first",
      segments: [
        {
          id: "earlier",
          text: "First sentence.",
          source: "system",
          speaker: "speaker_0",
          speakerName: "Outsider",
          speakerDecision: d,
        },
      ],
    });
    await settle();
    const row = store.useMeetingRecordingStore
      .getState()
      .segments.find((r) => r.text === "First sentence.");
    assert.ok(row);
    assert.equal(row.speakerName, undefined);
    assert.equal(row.speakerDecision.rejectionReason, "roster_changed");
    await store.stopRecording();
  });

test("run6: recording seed cannot overwrite the canonical stored veto with supplied evidence", async (t) => {
  const { api, notes } = createElectronAPI();
  const id = "bf99d416-46c6-4ca9-a057-68a1c5ca5bb9";
  const d = {
    decisionId: "canonical-veto",
    noteId: NOTE_ID,
    source: "note",
    rawRoster: "[]",
    rosterRevision: 0,
    eligibleProfileIds: [1],
    acceptedProfileId: null,
    rejectionReason: "no_match",
  };
  const row = { id, text: "stored", source: "system", speaker: "speaker_0", speakerDecision: d };
  notes.get(NOTE_ID).transcript = JSON.stringify({ version: 2, rows: [row] });
  const store = await loadStore(t, api);
  await store.startRecording({
    ...START_ARGS,
    seedSegments: [
      {
        ...row,
        speakerName: "Forged",
        speakerDecision: { ...d, acceptedProfileId: 1, rejectionReason: null },
      },
    ],
  });
  assert.equal(store.useMeetingRecordingStore.getState().segments[0].speakerName, undefined);
  assert.equal(
    store.useMeetingRecordingStore.getState().segments[0].speakerDecision.decisionId,
    "canonical-veto"
  );
  await store.stopRecording();
});

test("a 2000-row committed snapshot indexes live rows and resolves its roster once", async (t) => {
  const { api } = createElectronAPI();
  const store = await loadStore(t, api);
  let idReads = 0;
  const rows = Array.from({ length: 2000 }, (_, index) => ({
    get id() {
      idReads++;
      return `indexed-${index}`;
    },
    source: "system",
    text: `line ${index}`,
    speaker: "speaker_0",
  }));
  store.useMeetingRecordingStore.setState({ segments: rows });
  let parses = 0;
  const parse = JSON.parse;
  t.mock.method(JSON, "parse", (...args) => {
    parses++;
    return parse(...args);
  });
  const started = performance.now();
  const installed = store.mergeCommittedSpeakerRows(
    rows.map((row) => ({ ...row })),
    {
      noteScope: { id: NOTE_ID, participants: '[{"email":"a@example.com"}]' },
      preserveIdentifications: true,
    }
  );
  console.log(
    `COMMITTED_BATCH rows=2000 ms=${(performance.now() - started).toFixed(1)} idReads=${idReads} parses=${parses}`
  );
  assert.equal(installed.length, 2000);
  assert.ok(idReads < 20000, `live row identity reads: ${idReads}`);
  assert.ok(parses < 20, `roster parses: ${parses}`);
});

for (const route of [
  "initial",
  "retry",
  "diarization_skipped",
  "diarization_failed",
  "resumed live",
]) {
  test(`2000-row ${route} completion bounds parsing for every note snapshot`, async (t) => {
    let recordingStore;
    t.after(() => recordingStore?.stopRecording());
    const { api, state, notes } = createElectronAPI({ stopDiarizationSessionId: "earlier" });
    const { store, parseSeedSegments } = await loadModules(t, api);
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      id: `completion-${i}`,
      text: `line ${i}`,
      source: "system",
      timestamp: i,
      speaker: "speaker_0",
    }));
    notes.get(NOTE_ID).transcript = JSON.stringify({ version: 2, rows });
    if (route === "resumed live") {
      recordingStore = store;
      await store.startRecording(START_ARGS);
      // These rows belong to the first session, rather than its seed. The
      // later session resumes them while that first completion is pending.
      store.useMeetingRecordingStore.setState({ segments: rows });
      await store.stopRecording();
      await store.startRecording({
        ...START_ARGS,
        seedSegments: parseSeedSegments(notes.get(NOTE_ID).transcript),
      });
    }
    let attempts = 0;
    const done = deferred();
    api.meetingNoteFinalized = () => done.resolve();
    api.updateNote = async (_id, patch) => {
      if (++attempts === 1 && route === "retry")
        return { success: false, error: "transcript_changed" };
      notes.get(NOTE_ID).transcript = patch.transcript;
      return { success: true };
    };
    let parses = 0,
      transcriptParses = 0;
    const parse = JSON.parse;
    t.mock.method(JSON, "parse", (...args) => {
      parses++;
      if (typeof args[0] === "string" && args[0].includes('"line 1999"')) transcriptParses++;
      return parse(...args);
    });
    const started = performance.now();
    state.diarizationCallback({
      noteId: NOTE_ID,
      sessionId: "earlier",
      segments: rows,
      centroidPersistence: { cause: route },
    });
    await done.promise;
    console.log(
      `COMPLETION_BATCH route=${route} rows=2000 ms=${(performance.now() - started).toFixed(1)} parses=${parses} transcriptParses=${transcriptParses}`
    );
    assert.equal(transcriptParses, route === "retry" ? 8 : 4);
    assert.ok(parses < 100, `JSON parses: ${parses}`);
    const saved = parse(notes.get(NOTE_ID).transcript).rows;
    assert.equal(saved.length, 2000);
    assert.equal(new Set(saved.map((row) => row.id)).size, 2000);
  });
}
