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
  };
  return { calls, databaseManager };
}

const NOTE_ID = 42;
const embedding = Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0));

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

test("reconciliation keeps the mapping when live and offline ids already match", () => {
  const { IPCHandlers } = loadHandlers();
  const { calls, databaseManager } = createMappingRecorder([
    { speaker_id: "speaker_0", display_name: "Alice", profile_id: 5 },
  ]);

  reconcile(IPCHandlers, databaseManager, "speaker_0");

  assert.equal(calls.set.length, 1);
  assert.deepEqual(calls.set[0], {
    noteId: NOTE_ID,
    speakerId: "speaker_0",
    profileId: 5,
    displayName: "Alice",
  });
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
  const row = { id: "row-1", source: "system", speaker: "speaker_0", speakerStatus: "locked",
    speakerLocked: true, speakerLockSource: "user", speakerName: undefined, speakerIsPlaceholder: true };
  const note = { participants: JSON.stringify([{ email: "owner@example.com" }, { email: "alice@example.com", displayName: "Alice" }]), transcript: JSON.stringify([row]) };
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
    speaker: "speaker_0", speakerName: "Alice", speakerIsPlaceholder: false,
  });
  assert.equal(row.speakerName, undefined);
  assert.equal(row.speakerStatus, "locked");
  handlers._reconcileLiveSpeakerState(
    { speaker_0: { displayName: "Alice", profileId: 5, noteId: NOTE_ID, embedding } },
    { speaker_0: embedding }, [row]
  );
  assert.equal(row.speakerName, undefined);
  assert.equal(writes.length, 0);
});

test("one-on-one roster attaches a suggestion without confirming or mapping the voice", async () => {
  const { IPCHandlers } = loadHandlers();
  const row = { id: "row-2", source: "system", speaker: "speaker_0", speakerStatus: "provisional" };
  const note = { participants: JSON.stringify([{ email: "owner@example.com" },
    { email: "alice@example.com", displayName: "Alice" }]), transcript: JSON.stringify([row]) };
  const calls = [];
  const db = { getNote: () => note, getGoogleAccounts: () => [{ email: "owner@example.com" }],
    getNoteSpeakerEmbeddings: () => [{ speaker_id: "speaker_0" }], getSpeakerMappings: () => [],
    setSpeakerMapping: (...args) => calls.push(args), updateNote: (_id, patch) => Object.assign(note, patch) };
  Object.assign(Object.create(IPCHandlers.prototype), { databaseManager: db })._tryAutoLabelOneOnOne(NOTE_ID);
  await new Promise((resolve) => setImmediate(resolve));
  const [updated] = require("../../src/helpers/transcriptDocument").readTranscriptDocument(note.transcript).rows;
  assert.equal(updated.suggestedName, "Alice");
  assert.equal(updated.speakerName, undefined);
  assert.equal(updated.speakerStatus, "suggested");
  assert.equal(calls.length, 0);
});

test("attaching an email offers a suggestion without claiming an unranked voice", async () => {
  const { IPCHandlers } = loadHandlers();
  const vector = Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);
  const note = { transcript: JSON.stringify([{ id: 'voice', text: 'hello', source: 'system',
    speaker: 'speaker_0' }]) };
  const db = {
    getNotesWithUnmappedSpeakers: () => [NOTE_ID],
    getNoteSpeakerEmbeddings: () => [{ speaker_id: 'speaker_0', embedding: vector }],
    getSpeakerMappings: () => [],
    getSpeakerProfiles: () => [{ id: 8, display_name: 'Better candidate', embedding: vector }],
    getNote: () => note,
    updateNote: (_id, patch) => Object.assign(note, patch),
  };
  Object.assign(Object.create(IPCHandlers.prototype), { databaseManager: db })
    ._retroactiveMapping({ id: 7, display_name: 'Alex', embedding: vector });
  await new Promise((resolve) => setImmediate(resolve));
  const [saved] = require('../../src/helpers/transcriptDocument').readTranscriptDocument(note.transcript).rows;
  assert.equal(saved.speakerName, undefined);
  assert.equal(saved.suggestedName, 'Alex');
  assert.equal(saved.speakerStatus, 'suggested');
});

test("live reconciliation cannot restore a name to a short provisional row", () => {
  const { IPCHandlers } = loadHandlers();
  const row = { id: "short-row", speaker: "speaker_0", speakerName: undefined,
    speakerStatus: "provisional", speakerIsPlaceholder: true, uncertainty: { reason: "too_short" } };
  const { calls, databaseManager } = createMappingRecorder([]);
  const handlers = Object.assign(Object.create(IPCHandlers.prototype), { databaseManager });
  handlers._reconcileLiveSpeakerState(
    { speaker_0: { displayName: "Alice", profileId: 5, noteId: NOTE_ID, embedding } },
    { speaker_0: embedding }, [row]
  );
  assert.equal(row.speakerName, undefined);
  assert.equal(row.speakerStatus, "provisional");
  assert.equal(calls.set.length, 0);
});

test("a stop-time name wins over the live label on the same row", () => {
  const { IPCHandlers } = loadHandlers();
  const row = { id: "same-row", speaker: "speaker_0", speakerName: "Sam", speakerStatus: "confirmed" };
  const { databaseManager } = createMappingRecorder([]);
  const handlers = Object.assign(Object.create(IPCHandlers.prototype), { databaseManager });
  handlers._reconcileLiveSpeakerState(
    { speaker_0: { displayName: "Alex", profileId: 5, noteId: NOTE_ID, embedding } },
    { speaker_0: embedding }, [row]
  );
  assert.equal(row.speakerName, "Sam");
  assert.deepEqual(require("../../src/helpers/speakerUncertainty").changedAfterFinalReason("Alex", row.speakerName),
    { reason: "changed_after_final" });
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
  assert.deepEqual(
    resolve({}),
    { numSpeakers: -1, cap: null },
    "an unknown count stays unknown"
  );
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
  t.mock.method(speakerEmbeddings, "extractEmbedding", async () => new Float32Array([1, 0]));
  t.mock.method(speakerEmbeddings, "computeCentroid", (embeddings) => embeddings[0]);

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
  const win = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
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
      getNoteSpeakerEmbeddings: () => [],
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
  // Landed: narrowed to the two ids the result actually names.
  assert.equal(handlers._resolveMeetingSpeakerIndexBase(NOTE_ID, 0), 4);
});
