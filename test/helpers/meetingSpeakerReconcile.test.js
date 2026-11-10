const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const identifierModulePath = require.resolve("../../src/helpers/liveSpeakerIdentifier");
const originalLoad = Module._load;

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

// ipcHandlers pulls in a large module graph; stub the process boundaries and
// capture broadcasts so the prototype methods can run against a fake `this`.
function loadHandlers() {
  delete require.cache[handlersModulePath];
  delete require.cache[identifierModulePath];
  const broadcasts = [];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return electronStub;
    }
    if (request === "./windowBroadcast" && parent?.filename === handlersModulePath) {
      return {
        broadcastToWindows: (channel, payload) => {
          broadcasts.push({ channel, payload });
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const IPCHandlers = require(handlersModulePath);
    const liveSpeakerIdentifier = require(identifierModulePath);
    return { IPCHandlers, liveSpeakerIdentifier, broadcasts };
  } finally {
    Module._load = originalLoad;
  }
}

function createMappingRecorder(existingMappings) {
  const calls = { set: [], remove: [] };
  const databaseManager = {
    getSpeakerMappings: () => existingMappings,
    setSpeakerMapping: (noteId, speakerId, profileId, displayName) => {
      calls.set.push({ noteId, speakerId, profileId, displayName });
    },
    removeSpeakerMapping: (noteId, speakerId) => {
      calls.remove.push({ noteId, speakerId });
    },
    transferLegacySpeakerMapping: (noteId, sourceId, targetId, profileId, displayName) => {
      calls.set.push({ noteId, speakerId: targetId, profileId, displayName });
      calls.remove.push({ noteId, speakerId: sourceId });
    },
  };
  return { calls, databaseManager };
}

const NOTE_ID = 42;
const embedding = Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0));

test('unprotected rows require automatic evidence even when the live cluster was human named', () => {
  const { IPCHandlers } = loadHandlers();
  const profile = { id: 1, email: 'a@example.com', voice_usable: 1, embedding };
  const databaseManager = { getNote: () => ({ id: NOTE_ID, participants: '[]' }), getSpeakerProfiles: () => [profile] };
  const scope = require('../../src/helpers/noteSpeakerScope').readScope(databaseManager, NOTE_ID);
  const handlers = Object.assign(Object.create(IPCHandlers.prototype), { databaseManager });
  const rows = [{ speaker: 'speaker_0' }, { speaker: 'speaker_0', speakerName: 'Human outsider', speakerLocked: true }];
  handlers._applySpeakerName(rows, 'speaker_0', 'A', { profile, scope });
  assert.equal(rows[0].speakerName, undefined);
  assert.equal(rows[1].speakerName, 'Human outsider');
});

function reconcile(IPCHandlers, databaseManager, liveSpeakerId) {
  const fakeThis = Object.assign(Object.create(IPCHandlers.prototype), { databaseManager });
  const liveState = {
    [liveSpeakerId]: {
      displayName: "Alice",
      profileId: 5,
      noteId: NOTE_ID,
      embedding,
    },
  };
  const segments = [];
  return IPCHandlers.prototype._reconcileLiveSpeakerState.call(
    fakeThis,
    liveState,
    { speaker_0: embedding },
    segments
  );
}

test("offline system diarization cannot inherit a mic cohort name", () => {
  const { IPCHandlers } = loadHandlers();
  const { calls, databaseManager } = createMappingRecorder([]);
  const fakeThis = Object.assign(Object.create(IPCHandlers.prototype), { databaseManager });
  const rows = [{ source: "system", speaker: "speaker_0" }];
  const result = fakeThis._reconcileLiveSpeakerState(
    {
      speaker_3: { cohort: "mic", displayName: "Alex", profileId: 5, noteId: NOTE_ID, embedding },
    },
    { speaker_0: embedding },
    rows
  );
  assert.deepEqual([...result], []);
  assert.equal(rows[0].speakerName, undefined);
  assert.deepEqual(calls.set, []);
});

test("reconciliation leaves an existing same-id mapping alone", () => {
  const { IPCHandlers } = loadHandlers();
  const { calls, databaseManager } = createMappingRecorder([
    { speaker_id: "speaker_0", display_name: "Alice", profile_id: 5 },
  ]);

  reconcile(IPCHandlers, databaseManager, "speaker_0");

  assert.equal(calls.set.length, 0);
  assert.deepEqual(
    calls.remove,
    [],
    "removing the row that was just upserted deletes the user's identification"
  );
});

test("reconciliation migrates the mapping when the offline id differs", () => {
  const { IPCHandlers } = loadHandlers();
  const { calls, databaseManager } = createMappingRecorder([
    { speaker_id: "speaker_3", display_name: "Alice", profile_id: 5 },
  ]);

  reconcile(IPCHandlers, databaseManager, "speaker_3");

  assert.equal(calls.set.length, 1);
  assert.equal(calls.set[0].speakerId, "speaker_0");
  assert.deepEqual(calls.remove, [{ noteId: NOTE_ID, speakerId: "speaker_3" }]);
});

const THREE_ATTENDEES = [
  { email: "one@example.com" },
  { email: "two@example.com" },
  { email: "three@example.com" },
];

function refreshConfig(explicit, { expectedCount = 2, attendees = THREE_ATTENDEES } = {}) {
  const { IPCHandlers, liveSpeakerIdentifier, broadcasts } = loadHandlers();
  const fakeThis = Object.assign(Object.create(IPCHandlers.prototype), {
    activeMeetingSpeakerConfig: { enabled: true, expectedCount, explicit },
    _activeMeetingNoteId: NOTE_ID,
    databaseManager: { getGoogleAccounts: () => [] },
  });
  const note = { participants: JSON.stringify(attendees) };

  IPCHandlers.prototype._refreshMeetingSpeakerConfigFromNote.call(fakeThis, NOTE_ID, note);
  return { fakeThis, liveSpeakerIdentifier, broadcasts };
}

test("roster changes refresh an auto-derived speaker config", () => {
  const { fakeThis, liveSpeakerIdentifier, broadcasts } = refreshConfig(false);

  assert.equal(fakeThis.activeMeetingSpeakerConfig.expectedCount, 4);
  assert.equal(liveSpeakerIdentifier.maxSpeakers, 8);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].channel, "meeting-session-speaker-config-updated");
  assert.deepEqual(broadcasts[0].payload, { enabled: true, expectedCount: 4 });
});

test("a room on the note doesn't raise the speaker config", () => {
  const { fakeThis } = refreshConfig(false, {
    attendees: [...THREE_ATTENDEES, { email: "room@example.com", resource: true }],
  });

  assert.equal(fakeThis.activeMeetingSpeakerConfig.expectedCount, 4);
});

test("an explicit stepper count is never overridden by roster changes", () => {
  const { fakeThis, broadcasts } = refreshConfig(true);

  assert.equal(fakeThis.activeMeetingSpeakerConfig.expectedCount, 2);
  assert.deepEqual(broadcasts, []);
});

// Lowering the cap below the clusters already discovered makes the identifier
// fold every later voice onto an existing speaker — the collapse this refresh
// exists to prevent. A shrinking or emptied roster must be ignored.
test("a shrinking roster leaves the speaker cap untouched", () => {
  const shrunk = refreshConfig(false, {
    expectedCount: 4,
    attendees: [{ email: "one@example.com" }],
  });

  assert.equal(shrunk.fakeThis.activeMeetingSpeakerConfig.expectedCount, 4);
  assert.deepEqual(shrunk.broadcasts, []);

  const emptied = refreshConfig(false, { expectedCount: 4, attendees: [] });

  assert.equal(emptied.fakeThis.activeMeetingSpeakerConfig.expectedCount, 4);
  assert.deepEqual(emptied.broadcasts, []);
});

test("attendee suggestion and live reconciliation preserve a user-locked Unknown row", async () => {
  const { IPCHandlers } = loadHandlers();
  const row = {
    id: "row-1",
    source: "system",
    speaker: "speaker_0",
    speakerStatus: "locked",
    speakerLocked: true,
    speakerLockSource: "user",
    speakerName: undefined,
    speakerIsPlaceholder: true,
  };
  const note = {
    participants: JSON.stringify([
      { email: "owner@example.com" },
      { email: "alice@example.com", displayName: "Alice" },
    ]),
    transcript: JSON.stringify([row]),
  };
  const writes = [];
  const db = {
    getNote: () => note,
    getGoogleAccounts: () => [{ email: "owner@example.com" }],
    getNoteSpeakerEmbeddings: () => [{ speaker_id: "speaker_0" }],
    getSpeakerMappings: () => [],
    setSpeakerMapping: (...args) => writes.push(args),
    updateNote: (_id, patch) => Object.assign(note, patch),
  };
  const handlers = Object.assign(Object.create(IPCHandlers.prototype), { databaseManager: db });
  handlers._tryAutoLabelOneOnOne(NOTE_ID);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(note.transcript)[0].speakerName, undefined);
  assert.equal(writes.length, 0);
  // The live callback uses this same main-process writer for its identification.
  require("../../src/helpers/speakerAssignmentPolicy").applyConfirmedSpeaker(row, {
    speaker: "speaker_0",
    speakerName: "Alice",
    speakerIsPlaceholder: false,
  });
  assert.equal(row.speakerName, undefined);
  assert.equal(row.speakerStatus, "locked");
  handlers._reconcileLiveSpeakerState(
    { speaker_0: { displayName: "Alice", profileId: 5, noteId: NOTE_ID, embedding } },
    { speaker_0: embedding },
    [row]
  );
  assert.equal(row.speakerName, undefined);
  assert.equal(writes.length, 0);
});

test("one-on-one roster alone cannot suggest a name without approved acoustic evidence", async () => {
  const { IPCHandlers } = loadHandlers();
  const row = { id: "row-2", source: "system", speaker: "speaker_0", speakerStatus: "provisional" };
  const note = {
    participants: JSON.stringify([
      { email: "owner@example.com" },
      { email: "alice@example.com", displayName: "Alice" },
    ]),
    transcript: JSON.stringify([row]),
  };
  const calls = [];
  const db = {
    getNote: () => note,
    getGoogleAccounts: () => [{ email: "owner@example.com" }],
    getNoteSpeakerEmbeddings: () => [{ speaker_id: "speaker_0" }],
    getSpeakerMappings: () => [],
    setSpeakerMapping: (...args) => calls.push(args),
    updateNote: (_id, patch) => Object.assign(note, patch),
  };
  Object.assign(Object.create(IPCHandlers.prototype), {
    databaseManager: db,
  })._tryAutoLabelOneOnOne(NOTE_ID);
  await new Promise((resolve) => setImmediate(resolve));
  const [updated] = require("../../src/helpers/transcriptDocument").readTranscriptDocument(
    note.transcript
  ).rows;
  assert.equal(updated.suggestedName, undefined);
  assert.equal(updated.speakerName, undefined);
  assert.equal(updated.speakerStatus, "provisional");
  assert.equal(calls.length, 0);
});

test("attaching an email cannot suggest an unranked voice", async () => {
  const { IPCHandlers } = loadHandlers();
  const vector = Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);
  const note = {
    transcript: JSON.stringify([
      { id: "voice", text: "hello", source: "system", speaker: "speaker_0" },
    ]),
  };
  const db = {
    getNotesWithUnmappedSpeakers: () => [NOTE_ID],
    getNoteSpeakerEmbeddings: () => [{ speaker_id: "speaker_0", embedding: vector }],
    getSpeakerMappings: () => [],
    getSpeakerProfiles: () => [{ id: 8, display_name: "Better candidate", embedding: vector }],
    getNote: () => note,
    updateNote: (_id, patch) => Object.assign(note, patch),
  };
  Object.assign(Object.create(IPCHandlers.prototype), { databaseManager: db })._retroactiveMapping({
    id: 7,
    display_name: "Alex",
    embedding: vector,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const [saved] = require("../../src/helpers/transcriptDocument").readTranscriptDocument(
    note.transcript
  ).rows;
  assert.equal(saved.speakerName, undefined);
  assert.equal(saved.suggestedName, undefined);
  assert.equal(saved.speakerStatus, undefined);
});

test("live reconciliation cannot restore a name to a short provisional row", () => {
  const { IPCHandlers } = loadHandlers();
  const row = {
    id: "short-row",
    speaker: "speaker_0",
    speakerName: undefined,
    speakerStatus: "provisional",
    speakerIsPlaceholder: true,
    uncertainty: { reason: "too_short" },
  };
  const { calls, databaseManager } = createMappingRecorder([]);
  const handlers = Object.assign(Object.create(IPCHandlers.prototype), { databaseManager });
  handlers._reconcileLiveSpeakerState(
    { speaker_0: { displayName: "Alice", profileId: 5, noteId: NOTE_ID, embedding } },
    { speaker_0: embedding },
    [row]
  );
  assert.equal(row.speakerName, undefined);
  assert.equal(row.speakerStatus, "provisional");
  assert.equal(calls.set.length, 0);
});

test("a stop-time name wins over the live label on the same row", () => {
  const { IPCHandlers } = loadHandlers();
  const row = {
    id: "same-row",
    speaker: "speaker_0",
    speakerName: "Sam",
    speakerStatus: "confirmed",
  };
  const { databaseManager } = createMappingRecorder([]);
  const handlers = Object.assign(Object.create(IPCHandlers.prototype), { databaseManager });
  handlers._reconcileLiveSpeakerState(
    { speaker_0: { displayName: "Alex", profileId: 5, noteId: NOTE_ID, embedding } },
    { speaker_0: embedding },
    [row]
  );
  assert.equal(row.speakerName, "Sam");
  assert.deepEqual(
    require("../../src/helpers/speakerUncertainty").changedAfterFinalReason(
      "Alex",
      row.speakerName
    ),
    { reason: "changed_after_final" }
  );
});

function makeExpectationResolver() {
  const { IPCHandlers } = loadHandlers();
  return (args) =>
    IPCHandlers.prototype._resolveSpeakerExpectation.call(
      Object.assign(Object.create(IPCHandlers.prototype), {
        databaseManager: { getNote: () => args.note ?? null },
      }),
      {
        sessionConfig: args.sessionConfig ?? null,
        noteId: args.noteId ?? null,
        observedSpeakerIds: args.observedSpeakerIds ?? new Set(),
        diarizedSource: args.diarizedSource,
      }
    );
}

// System mode: only system audio reaches the diarizer (the mic track is "you"),
// so every branch must report `cap` as a count of other speakers (total - 1).
// The no-signal fallback used to return the total itself, which let one remote
// voice split across two labels.
test("speaker expectation reports cap as other-speaker count in every system-mode branch", () => {
  const resolve = makeExpectationResolver();

  assert.deepEqual(
    resolve({ sessionConfig: { expectedCount: 3, explicit: true } }),
    { numSpeakers: 2, cap: 2 },
    "an explicit count of 3 means 2 other speakers"
  );
  assert.deepEqual(
    resolve({ noteId: NOTE_ID, note: { expected_speaker_count: 4 } }),
    { numSpeakers: 3, cap: 3 },
    "a note count outranks a non-explicit session config"
  );
  assert.deepEqual(
    resolve({ observedSpeakerIds: new Set(["speaker_0", "speaker_1"]) }),
    { numSpeakers: -1, cap: null },
    "observed live ids do not constrain final diarization"
  );
  assert.deepEqual(resolve({}), { numSpeakers: -1, cap: null }, "an unknown count stays unknown");
});

// Mic mode (in-person session): the user is one of the diarized voices, so the
// expected total applies without the -1 the system-mode branches use.
test("mic mode counts the user among the expected speakers", () => {
  const resolve = makeExpectationResolver();

  assert.deepEqual(
    resolve({ sessionConfig: { expectedCount: 3, explicit: true }, diarizedSource: "mic" }),
    { numSpeakers: 3, cap: 3 },
    "an explicit total of 3 stays 3, not total - 1"
  );
  assert.deepEqual(
    resolve({ diarizedSource: "mic" }),
    { numSpeakers: -1, cap: null },
    "an unknown mic count stays unknown"
  );
});

// A resumed note's mappings and embeddings can hold ids no transcript row
// carries any more; the session's base must clear them too, or a new voice
// would inherit that stored name.
test("a resumed meeting's speaker base clears the note's stored ids", () => {
  const { IPCHandlers } = loadHandlers();
  const resolveBase = IPCHandlers.prototype._resolveMeetingSpeakerIndexBase;
  const handlers = {
    _diarizationSpeakerReservations: new Map(),
    databaseManager: {
      getSpeakerMappings: () => [{ speaker_id: "speaker_0" }, { speaker_id: "speaker_3" }],
      getNoteSpeakerEmbeddings: () => [{ speaker_id: "speaker_1" }],
    },
  };

  assert.equal(resolveBase.call(handlers, NOTE_ID, 2), 4);
  assert.equal(resolveBase.call(handlers, NOTE_ID, 6), 6);
  assert.equal(resolveBase.call(handlers, null, 2), 2);

  const failing = {
    _diarizationSpeakerReservations: new Map(),
    databaseManager: {
      getSpeakerMappings: () => {
        throw new Error("db closed");
      },
    },
  };
  assert.equal(resolveBase.call(failing, NOTE_ID, 2), 2);
});

function loadDiarizationManager() {
  const diarizationPath = require.resolve("../../src/helpers/diarization");
  delete require.cache[diarizationPath];
  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === "electron") return electronStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(diarizationPath);
  } finally {
    Module._load = originalLoad;
  }
}

// "Record more" can start while the previous session's diarization still runs:
// its clusters are in neither the seeded transcript nor the stored embeddings
// yet, so the next session's base must clear every id the result can name.
test("a stopped session's diarization reserves its speaker ids until its result lands", async (t) => {
  const { IPCHandlers } = loadHandlers();
  const DiarizationManager = loadDiarizationManager();
  const speakerEmbeddings = require("../../src/helpers/speakerEmbeddings");
  t.mock.method(speakerEmbeddings, "isAvailable", () => true);
  t.mock.method(
    speakerEmbeddings,
    "extractClusterCentroids",
    async () =>
      new Map([
        ["speaker_00", new Float32Array([1, 0])],
        ["speaker_01", new Float32Array([0, 1])],
      ])
  );

  let releaseDiarization;
  const diarizationGate = new Promise((resolve) => {
    releaseDiarization = resolve;
  });
  const diarizationManager = new DiarizationManager();
  Object.assign(diarizationManager, {
    isAvailable: () => true,
    convertRawPcmToWav: async () => "/nonexistent/ow-reserve-test.wav",
    diarize: async () => {
      await diarizationGate;
      return [
        { start: 0, end: 4, speaker: "speaker_00" },
        { start: 5, end: 9, speaker: "speaker_01" },
      ];
    },
  });

  const sent = [];
  const stored = [];
  let completionAtSend;
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) =>
        sent.push({ channel, payload, storedAtSend: [...stored], completionAtSend }),
    },
  };
  const handlers = Object.assign(Object.create(IPCHandlers.prototype), {
    _diarizationSpeakerReservations: new Map(),
    speakerDiarizationEnabled: true,
    diarizationManager,
    databaseManager: {
      // Four expected speakers: up to three remote clusters.
      getNote: () => ({ expected_speaker_count: 4 }),
      getSpeakerProfiles: () => [],
      getSpeakerMappings: () => [],
      getNoteSpeakerEmbeddings: () => stored,
      saveNoteSpeakerEmbeddings: (_noteId, embeddings) => {
        stored.push(...Object.keys(embeddings).map((speaker_id) => ({ speaker_id })));
        return { success: true };
      },
      saveNoteSpeakerCompletion: (_noteId, evidence) => {
        completionAtSend = evidence;
      },
    },
  });

  handlers._startOrSkipDiarization(
    "diar-1",
    "/nonexistent/ow-reserve-test.pcm",
    0,
    [
      { id: "a", source: "system", timestamp: 1, text: "first", speaker: "speaker_2" },
      { id: "b", source: "system", timestamp: 6, text: "second", speaker: "speaker_2" },
    ],
    win,
    null,
    null,
    NOTE_ID,
    "system",
    2
  );

  // Pending: the base must clear speaker_2..speaker_4.
  assert.equal(handlers._resolveMeetingSpeakerIndexBase(NOTE_ID, 3), 5);
  assert.equal(handlers._resolveMeetingSpeakerIndexBase(NOTE_ID + 1, 0), 0);

  releaseDiarization();
  for (let i = 0; i < 50 && sent.length === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const { payload } = sent[0];
  assert.deepEqual(
    payload.segments.map((segment) => segment.speaker),
    ["speaker_2", "speaker_3"]
  );
  assert.deepEqual(Object.keys(payload.speakerEmbeddings).sort(), ["speaker_2", "speaker_3"]);
  assert.deepEqual(stored.map((item) => item.speaker_id).sort(), ["speaker_2", "speaker_3"]);
  assert.deepEqual(sent[0].storedAtSend.map((item) => item.speaker_id).sort(), [
    "speaker_2",
    "speaker_3",
  ]);
  assert.equal(sent[0].completionAtSend.vectorsWritten, 2);
  assert.deepEqual(payload.centroidPersistence, sent[0].completionAtSend);
  // Landed: narrowed to the two ids the result actually names.
  assert.equal(handlers._resolveMeetingSpeakerIndexBase(NOTE_ID, 0), 4);
});

test("skipped and failed diarization record their real completion causes", async () => {
  const { IPCHandlers } = loadHandlers();
  const DiarizationManager = loadDiarizationManager();
  for (const enabled of [false, true]) {
    let completion;
    const handlers = Object.assign(Object.create(IPCHandlers.prototype), {
      _diarizationSpeakerReservations: new Map(),
      speakerDiarizationEnabled: enabled,
      diarizationManager: Object.assign(new DiarizationManager(), {
        isAvailable: () => true,
        convertRawPcmToWav: async () => {
          throw new Error("fixture conversion failure");
        },
      }),
      databaseManager: {
        getNote: () => ({}),
        getSpeakerMappings: () => [],
        saveNoteSpeakerCompletion: (_noteId, value) => {
          completion = value;
        },
      },
    });
    const payload = await new Promise((resolve) => {
      handlers._startOrSkipDiarization(
        "completion-cause",
        "/nonexistent/ow-cause.pcm",
        0,
        [{ id: "row", source: "system", timestamp: 1, text: "hello" }],
        { isDestroyed: () => false, webContents: { send: (_channel, value) => resolve(value) } },
        null,
        null,
        NOTE_ID,
        "system",
        0
      );
    });
    assert.equal(completion.cause, enabled ? "diarization_failed" : "diarization_skipped");
    assert.deepEqual(payload.centroidPersistence, completion);
    assert.equal(payload.segments[0].text, "hello");
  }
});

test("completion persistence reports empty extraction, expired audio, and rejected writes", async () => {
  const { IPCHandlers } = loadHandlers();
  let state = "complete";
  let attempts = 0;
  const handlers = Object.assign(Object.create(IPCHandlers.prototype), {
    meetingAudioStore: { status: () => ({ state }) },
    databaseManager: {
      saveNoteSpeakerEmbeddings: () => {
        attempts++;
        return { success: false, error: "database_busy" };
      },
      getNoteSpeakerEmbeddings: () => [],
    },
  });
  assert.deepEqual(
    await handlers._persistMeetingSpeakerCentroids(
      42,
      ["speaker_7"],
      {},
      "embedding_extraction_failed"
    ),
    {
      clusters: 1,
      vectorsWritten: 0,
      cause: "embedding_extraction_failed",
    }
  );
  state = "expired";
  assert.deepEqual(
    await handlers._persistMeetingSpeakerCentroids(42, ["speaker_7"], { speaker_7: [1, 0] }),
    {
      clusters: 1,
      vectorsWritten: 0,
      cause: "audio_state:expired",
    }
  );
  state = "complete";
  assert.deepEqual(
    await handlers._persistMeetingSpeakerCentroids(42, ["speaker_7"], { speaker_7: [1, 0] }),
    {
      clusters: 1,
      vectorsWritten: 0,
      cause: "write_rejected:database_busy",
    }
  );
  assert.equal(attempts, 2);
});

test("empty centroid extraction is recorded before a completed diarisation is announced", async (t) => {
  const { IPCHandlers } = loadHandlers();
  const DiarizationManager = loadDiarizationManager();
  const speakerEmbeddings = require("../../src/helpers/speakerEmbeddings");
  t.mock.method(speakerEmbeddings, "isAvailable", () => true);
  t.mock.method(speakerEmbeddings, "extractClusterCentroids", async () => new Map());
  const diarizationManager = new DiarizationManager();
  Object.assign(diarizationManager, {
    isAvailable: () => true,
    convertRawPcmToWav: async () => "/nonexistent/ow-empty-centroid.wav",
    diarize: async () => [{ start: 0, end: 4, speaker: "speaker_00" }],
  });
  let completion;
  const handlers = Object.assign(Object.create(IPCHandlers.prototype), {
    _diarizationSpeakerReservations: new Map(),
    speakerDiarizationEnabled: true,
    diarizationManager,
    meetingAudioStore: { status: () => ({ state: "complete", recordingId: 1 }) },
    databaseManager: {
      getNote: () => ({ expected_speaker_count: 1 }),
      getSpeakerProfiles: () => [],
      getSpeakerMappings: () => [],
      getNoteSpeakerEmbeddings: () => [],
      saveNoteSpeakerCompletion: (_noteId, value) => {
        completion = value;
      },
    },
  });
  const payload = await new Promise((resolve) => {
    handlers._startOrSkipDiarization(
      "empty-centroid",
      "/nonexistent/ow-empty-centroid.pcm",
      0,
      [{ id: "row", source: "system", timestamp: 1, text: "hello" }],
      { isDestroyed: () => false, webContents: { send: (_channel, value) => resolve(value) } },
      null,
      null,
      NOTE_ID,
      "system",
      0
    );
  });
  assert.equal(payload.segments.length, 1);
  assert.equal(completion.cause, "embedding_extraction_failed");
  assert.deepEqual(payload.centroidPersistence, completion);
  assert.equal(completion.vectorsWritten, 0);
});

const rosterProfiles = () => [
  { id: 1, display_name: "A", email: "a@example.com", voice_usable: 1, sample_count: 3, embedding: Buffer.from(new Float32Array([.7, Math.sqrt(.51), 0]).buffer) },
  { id: 2, display_name: "B", email: "b@example.com", voice_usable: 1, sample_count: 3, embedding: Buffer.from(new Float32Array([.3, 0, Math.sqrt(.91)]).buffer) },
  { id: 3, display_name: "C", email: "c@example.com", voice_usable: 1, sample_count: 3, embedding: Buffer.from(new Float32Array([.95, Math.sqrt(.0975), 0]).buffer) },
];
const declaredAB = JSON.stringify([{email:"a@example.com"}, {email:"b@example.com"}]);
function rosterHandlers() {
  const { IPCHandlers } = loadHandlers();
  const note = { id: NOTE_ID, participants: declaredAB, transcript: "[]" };
  const profiles = rosterProfiles();
  const writes = [];
  const databaseManager = {
    getNote: () => note,
    getSpeakerProfiles: () => profiles,
    getSpeakerMappings: () => [],
    getNotesWithUnmappedSpeakers: () => [NOTE_ID],
    getNoteSpeakerEmbeddings: () => [{ speaker_id: "speaker_0", embedding: Buffer.from(new Float32Array([1,0,0]).buffer) }],
    updateNote: (_id, patch) => { writes.push(patch); Object.assign(note, patch); return {success:true}; },
    saveNoteSpeakerEmbeddings: () => ({ success: true }),
  };
  const handlers = Object.assign(Object.create(IPCHandlers.prototype), {
    databaseManager, speakerDiarizationEnabled: true, _diarizationSpeakerReservations: new Map(),
  });
  return {handlers,note,profiles,writes};
}
async function rosterFinal(t, f, { enabled = true, fail = false, beforeCentroids, voice = [1,0,0], extra = [] } = {}) {
  const DiarizationManager = loadDiarizationManager();
  const embeddings = require("../../src/helpers/speakerEmbeddings");
  t.mock.method(embeddings, "isAvailable", () => true);
  t.mock.method(embeddings, "extractClusterCentroids", async () => {
    beforeCentroids?.();
    return new Map([["speaker_00", new Float32Array(voice)], ...extra]);
  });
  f.handlers.speakerDiarizationEnabled = enabled;
  f.handlers.diarizationManager = Object.assign(new DiarizationManager(), {
    isAvailable: () => true,
    convertRawPcmToWav: async () => { if (fail) throw Error("fixture failure"); return "/nonexistent/roster.wav"; },
    diarize: async () => [{start:0,end:4,speaker:"speaker_00"}, ...extra.map(([speaker], i) => ({ start:5+i*5,end:9+i*5,speaker }))],
  });
  return new Promise(resolve => f.handlers._startOrSkipDiarization("roster-run", "/nonexistent/roster.pcm", 0,
    [{id:"row",source:"system",timestamp:1,text:"hello", speaker:"speaker_0", speakerName:"C"},
      ...extra.map((_,i) => ({id:`extra-${i}`,source:"system",timestamp:6+i*5,text:"other"}))],
    {isDestroyed:()=>false,webContents:{send:(_channel,payload)=>resolve(payload)}}, null, null, NOTE_ID));
}

test("roster owner regression: final global winner C is Unknown without promoting A", async t => {
  const f = rosterHandlers();
  const result = await rosterFinal(t, f);
  assert.equal(result.segments[0].speakerName, undefined);
  assert.equal(result.segments[0].suggestedName, undefined);
  assert.equal(result.segments[0].speakerDecision.rejectionReason, "outside_roster");
});
test("roster positive: acoustic participant A remains recognised with the actual roster snapshot", async t => {
  const f = rosterHandlers();
  f.profiles[0].embedding = Buffer.from(new Float32Array([1,0,0]).buffer);
  f.profiles[2].embedding = Buffer.from(new Float32Array([0,0,1]).buffer);
  const result = await rosterFinal(t, f);
  assert.equal(result.segments[0].speakerName, "A");
  assert.deepEqual(result.segments[0].speakerDecision.roster, JSON.parse(declaredAB));
});
test("roster reconciliation cannot inherit C from a live cluster", () => {
  const f = rosterHandlers();
  const row = {id:"row",speaker:"speaker_0",source:"system"};
  f.handlers._reconcileLiveSpeakerState({speaker_0:{displayName:"C",profileId:3,noteId:NOTE_ID,embedding:[1,0,0]}}, {speaker_0:[1,0,0]}, [row]);
  assert.equal(row.speakerName, undefined);
});
test("roster skipped and failed final paths veto cached C", async t => {
  for (const options of [{enabled:false},{fail:true}]) {
    const f = rosterHandlers();
    const result = await rosterFinal(t, f, options);
    assert.equal(result.segments[0].speakerName, undefined);
    assert.equal(result.segments[0].speakerIsPlaceholder, true);
  }
});
test("roster delayed retroactive job cannot suggest outsider C", async () => {
  const f = rosterHandlers();
  f.note.transcript = JSON.stringify([{id:"row",source:"system",speaker:"speaker_0",text:"hello"}]);
  f.note.participants = JSON.stringify([...JSON.parse(declaredAB), {email:"c@example.com"}]);
  f.handlers._retroactiveMapping(f.profiles[2]);
  f.note.participants = declaredAB;
  await new Promise(resolve => setImmediate(resolve));
  const row = require("../../src/helpers/transcriptDocument").readTranscriptDocument(f.note.transcript).rows[0];
  assert.equal(row.suggestedName, undefined);
});
test("roster final arriving after participant removal cannot retain a previously valid name", async t => {
  const f = rosterHandlers();
  f.profiles[0].embedding = Buffer.from(new Float32Array([1,0,0]).buffer);
  f.profiles[2].embedding = Buffer.from(new Float32Array([0,0,1]).buffer);
  const result = await rosterFinal(t, f, {beforeCentroids:()=>{f.note.participants=JSON.stringify([{email:"b@example.com"}]);}});
  assert.equal(result.segments[0].speakerName, undefined);
});

for (const [label, participants, event, expected] of [
  ["declared beats a larger event", declaredAB, {attendees: JSON.stringify([{email:"c@example.com"}])}, undefined],
  ["explicit empty ignores event", "[]", {attendees: declaredAB}, "C"],
  ["absent without event keeps global naming", null, null, "C"],
  ["NULL ignores linked event attendees", null, {attendees: declaredAB}, "C"],
  ["malformed fails closed", "{broken", {attendees:"[]"}, undefined],
  ["JSON null fails closed", "null", null, undefined],
  ["NULL ignores missing linked event", null, undefined, "C"],
  ["email case and whitespace", JSON.stringify([{email:" C@EXAMPLE.COM "}]), null, "C"],
  ["display name is insufficient", JSON.stringify([{displayName:"C"}]), null, undefined],
  ["unprofiled participant", JSON.stringify([{email:"new@example.com"}]), null, undefined],
  ["declared resource", JSON.stringify([{email:"c@example.com",resource:true}]), null, "C"],
  ["declared declined guest", JSON.stringify([{email:"c@example.com",responseStatus:"declined"}]), null, "C"],
  ["declined self", JSON.stringify([{email:"c@example.com",responseStatus:"declined",self:true}]), null, "C"],
]) test(`roster precedence and identity: ${label}`, async t => {
  const f = rosterHandlers();
  f.note.participants = participants;
  if (event !== null) { f.note.calendar_event_id = "linked"; f.handlers.databaseManager.getCalendarEventById = () => event; }
  const result = await rosterFinal(t,f);
  assert.equal(result.segments[0].speakerName, expected);
  assert.equal(result.segments[0].speakerDecision.candidateSetStatus,"recorded");
});

test("roster identity: duplicate names never resolve a different email or ambiguous legacy link", async t => {
  const f = rosterHandlers();
  f.profiles[0].display_name = "C";
  f.note.participants = JSON.stringify([{email:"a@example.com",displayName:"C",profileId:3}]);
  assert.equal((await rosterFinal(t,f)).segments[0].speakerName, undefined);
});
test("roster identity: duplicate profile emails fail closed", async t => {
  const f = rosterHandlers();
  f.profiles[0].email = "c@example.com";
  f.note.participants = JSON.stringify([{email:"c@example.com"}]);
  assert.equal((await rosterFinal(t,f)).segments[0].speakerName, undefined);
});
test("roster outsider remains a distinct unknown cluster beyond the participant count", async t => {
  const f = rosterHandlers();
  f.note.participants = JSON.stringify([{email:"a@example.com"}]);
  f.profiles[0].embedding = Buffer.from(new Float32Array([0,0,1]).buffer);
  f.profiles[1].embedding = Buffer.from(new Float32Array([0,1,0]).buffer);
  const result = await rosterFinal(t,f,{extra:[["speaker_01",new Float32Array([0,0,1])]]});
  assert.equal(result.segments.length,2);
  assert.equal(result.segments[0].speakerName,undefined);
  assert.equal(result.segments[1].speakerName,"A");
  assert.notEqual(result.segments[0].speaker,result.segments[1].speaker);
});
test("roster added during final recognition needs a new acoustic run", async t => {
  const f=rosterHandlers();
  const result=await rosterFinal(t,f,{beforeCentroids:()=>{f.note.participants=JSON.stringify([{email:"c@example.com"}]);}});
  assert.equal(result.segments[0].speakerName,undefined);
  assert.equal(result.segments[0].speakerDecision.rejectionReason,"roster_changed");
});
for (const lock of [{speakerLocked:true},{speakerLockSource:"user"},{speakerStatus:"locked"},{speakerStatus:"user_locked"}]) {
  for (const name of ["C", undefined]) test(`roster late final respects ${JSON.stringify(lock)} and ${name || "explicit Unknown"}`,async t=>{
    const f=rosterHandlers();
    const result=await rosterFinal(t,f,{beforeCentroids:()=>{f.note.transcript=JSON.stringify([{id:"row",source:"system",speaker:"speaker_0",speakerName:name,speakerIsPlaceholder:!name,...lock}]);}});
    assert.equal(result.segments[0].speakerName,name);
    assert.equal(result.segments[0].speakerLocked,true);
    assert.equal(f.note.participants,declaredAB);
  });
}

test("roster cohort suggestion cannot name outsider C when raw winner A is invited", async t => {
  const f=rosterHandlers();
  f.profiles[0].embedding=Buffer.from(new Float32Array([.9,Math.sqrt(.19),0]).buffer);
  f.profiles[1].embedding=Buffer.from(new Float32Array([.2,0,Math.sqrt(.96)]).buffer);
  f.profiles[2].embedding=Buffer.from(new Float32Array([.8,-.6,0]).buffer);
  const result=await rosterFinal(t,f,{extra:[["speaker_01",new Float32Array([0,1,0])]]});
  assert.equal(result.segments[0].speakerName,undefined);
  assert.equal(result.segments[0].suggestedName,undefined);
  assert.equal(result.segments[0].speakerDecision.path,"final_cohort");
  const d = result.segments[0].speakerDecision;
  assert.equal(d.acousticWinnerProfileId, 1, 'cohort selection must not replace the raw winner');
  assert.equal(d.acousticRunnerUpProfileId, 3);
  assert.ok(Math.abs(d.scores.best - .9) < 1e-6);
  assert.ok(Math.abs(d.scores.runnerUp - .8) < 1e-6);
  assert.equal(d.cohortSelection.profileId, 3);
  assert.equal(d.cohortSelection.accepted, false);
  assert.equal(d.rawDecision.acousticWinnerProfileId, 1);
  assert.deepEqual(d.rawDecision.scores, d.scores);
  assert.equal(d.effectiveThresholds.similarityFloor, require('../../src/helpers/speakerDecisionThresholds').effectiveFloor());
  assert.equal(d.cohortSelection.rawFloor, .5);
});

test("roster direct reconciliation veto clears cached outsider names and suggestions",()=>{
  const f=rosterHandlers();
  const row={speaker:"speaker_0",source:"system",speakerName:"C",suggestedName:"C",suggestedProfileId:3};
  f.handlers._reconcileLiveSpeakerState({speaker_0:{displayName:"C",profileId:3,noteId:NOTE_ID,embedding:[1,0,0]}},{speaker_0:[1,0,0]},[row]);
  assert.equal(row.speakerName,undefined);
  assert.equal(row.suggestedName,undefined);
});
test("roster provenance records the unchanged global acoustic comparison and reconstructable snapshots",async t=>{
  const f=rosterHandlers();
  const options=[];
  f.handlers.databaseManager.getSpeakerProfiles=(...args)=>{options.push(args);return f.profiles;};
  const result=await rosterFinal(t,f);
  const d=result.segments[0].speakerDecision;
  assert.equal(d.runId,"roster-run");
  assert.equal(d.source,"note");
  assert.equal(d.rawRoster,declaredAB);
  assert.deepEqual(d.roster,JSON.parse(declaredAB));
  assert.deepEqual(d.eligibleProfileIds,[1,2]);
  assert.equal(d.policyVersion,1);
  assert.equal(d.acousticWinnerProfileId,3);
  assert.equal(d.acceptedProfileId,null);
  assert.equal(d.origin,"machine");
  assert.equal(d.path,"final");
  assert.ok(Math.abs(d.scores.best-.95)<1e-6);
  assert.ok(Math.abs(d.scores.runnerUp-.7)<1e-6);
  assert.deepEqual(d.profileFingerprints.map(p=>p.id),[1,2,3]);
  assert.ok(d.profileFingerprints.every(p=>/^[a-f0-9]{64}$/.test(p.fingerprint)));
  assert.ok(options.some(args=>args[0]===true && args[1]?.includeProvisional===true));
  assert.ok(options.every(args=>args[1]?.noteId===undefined));
});

test("roster participant without approved voice stays Unknown without an outsider or provisional suggestion",async t=>{
  const f=rosterHandlers();
  f.note.participants=JSON.stringify([{email:'c@example.com'}]);
  f.profiles[2].voice_usable=0;
  const result=await rosterFinal(t,f);
  assert.equal(result.segments[0].speakerName,undefined);
  assert.equal(result.segments[0].suggestedName,undefined);
  assert.equal(result.segments[0].speakerDecision.rejectionReason,'voice_not_approved');
});
