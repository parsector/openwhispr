const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const os = require("node:os");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const ts = require("typescript");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

// ipcHandlers and diarization.js reach for electron at load time; speaker
// embeddings stay off so the diarized path needs no ONNX worker.
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => os.tmpdir(),
        getAppPath: () => process.cwd(),
        getName: () => "test",
        getVersion: () => "0.0.0",
        isPackaged: false,
        on: () => {},
      },
      ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
      net: {},
      BrowserWindow: class BrowserWindow {
        static getAllWindows() {
          return [];
        }
      },
      screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
      systemPreferences: { getMediaAccessStatus: () => "granted" },
      session: { fromPartition: () => ({}) },
      shell: {},
      dialog: {},
      clipboard: {},
      nativeImage: {},
      globalShortcut: {},
      utilityProcess: {},
      MessageChannelMain: class {},
    };
  }
  if (parent?.filename === handlersModulePath && request === "./speakerEmbeddings") {
    return { isAvailable: () => false };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const IPCHandlers = require(handlersModulePath);
const DiarizationManager = require("../../src/helpers/diarization.js");
const { mergeSessionDiarization } = require("../../src/utils/diarizationCompletion.ts");
const { parseTranscriptSegments } = require("../../src/utils/parseTranscriptSegments.ts");
const { serializeTranscriptSegments } = require("../../src/utils/transcriptSpeakerState.ts");

test.after(() => {
  Module._load = originalLoad;
});

// #2781: a few mic rows were saved with epoch-ms timestamps and no speaker.
// Live segments carry Date.now() timestamps; main normalizes its copy to
// seconds, and the renderer merges main's result onto the transcript it
// persisted at stop.

const START_MS = 1792414000000;

// Runs main's real _startOrSkipDiarization and resolves with the payload it
// sends. `outcome` picks the diarized, skipped or failed path.
const runMainDiarization = (mainSegments, { retracted = [], outcome = "diarized", finalName } = {}) =>
  new Promise((resolve) => {
    const diarizationManager = new DiarizationManager();
    diarizationManager.isAvailable = () => outcome !== "skipped";
    diarizationManager.convertRawPcmToWav = async () => {
      if (outcome === "failed") throw new Error("Raw PCM file is empty");
      return "/nonexistent/diarization.wav";
    };
    diarizationManager.diarize = async () => [{ start: 0, end: 120, speaker: "speaker_00" }];
    if (finalName) {
      const merge = diarizationManager.mergeWithTranscript.bind(diarizationManager);
      diarizationManager.mergeWithTranscript = (...args) => merge(...args).map((seg) => ({ ...seg, speakerName: finalName }));
    }

    const handlers = Object.create(IPCHandlers.prototype);
    Object.assign(handlers, {
      diarizationManager,
      speakerDiarizationEnabled: true,
      _diarizationSpeakerReservations: new Map(),
      _resolveSpeakerExpectation: () => ({ numSpeakers: 0, cap: null }),
      _reconcileLiveSpeakerState: () => new Map(),
    });
    const win = {
      isDestroyed: () => false,
      webContents: { send: (_channel, payload) => resolve(payload) },
    };

    handlers._startOrSkipDiarization(
      "diar-1",
      "/nonexistent/meeting.pcm",
      START_MS,
      mainSegments,
      win,
      null,
      null,
      1,
      "system",
      0,
      retracted
    );
  });

// The renderer's meeting-diarization-complete listener, from the transcript it
// persisted at stop (serialized and read back from the note).
const runRendererCompletion = (live, payload, seed = []) => {
  assert.ok(payload.segments.length > 0, "the renderer ignores removedSegments without segments");
  const existing = parseTranscriptSegments(serializeTranscriptSegments([...seed, ...live]));
  return mergeSessionDiarization({
    existing,
    seedLength: seed.length,
    segments: payload.segments,
    removedSegments: payload.removedSegments,
  }).segments;
};

const stripIds = (segments) => segments.map(({ id: _id, ...segment }) => segment);
const rows = (segments) => segments.map((segment) => [segment.source, segment.text]);

const assertNoEpochTimestamps = (segments) => {
  for (const segment of segments) {
    assert.ok(
      segment.timestamp == null || segment.timestamp < 1e9,
      `segment "${segment.text}" (${segment.source}) kept epoch timestamp ${segment.timestamp}`
    );
  }
};

const echoed = "let's ship the pricing page on friday";
const liveWithEcho = [
  { id: "seg-1", source: "mic", text: "morning everyone", timestamp: START_MS + 2000 },
  { id: "seg-2", source: "system", text: echoed, timestamp: START_MS + 10000 },
  // Released after holdback with no live match, then confirmed as echo by the
  // post-session dedupe.
  {
    id: "seg-3",
    source: "mic",
    text: echoed,
    timestamp: START_MS + 11000,
    hasBleedEvidence: true,
  },
];

test("main final analysis finds the prior row by its ingestion id", async () => {
  // Execute the real main-process ingestion helpers with a captured IPC send.
  const source = ts.createSourceFile("ipcHandlers.js", fs.readFileSync(handlersModulePath, "utf8"), ts.ScriptTarget.Latest, true);
  const arrows = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        ["storeMeetingDiarizationSegment", "sendMeetingFinalSegment"].includes(node.name.text)) {
      arrows.set(node.name.text, node.initializer.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const stored = [];
  const sent = [];
  const context = { crypto, meetingConnectionOptions: { sessionId: "diar-1" }, meetingDiarizationSegments: stored, appendMeetingLocalTranscript() {} };
  const store = vm.runInNewContext(`(${arrows.get("storeMeetingDiarizationSegment")})`, context);
  const sendFinal = vm.runInNewContext(`(${arrows.get("sendMeetingFinalSegment")})`, {
    ...context, storeMeetingDiarizationSegment: store,
  });
  sendFinal({ text: "hello", source: "system", timestamp: START_MS + 1000,
    send: (channel, row) => sent.push([channel, row]) });
  const id = stored[0].id;
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i);
  assert.equal(stored[0].diarizationRunId, "diar-1");
  assert.equal(sent[0][1].id, id);
  stored[0].speakerName = "Alex";
  const payload = await runMainDiarization(stored, { finalName: "Sam" });
  assert.equal(payload.segments[0].id, id);
  assert.deepEqual(payload.segments[0].uncertainty, { reason: "changed_after_final" });
  const merged = runRendererCompletion([
    { id, source: "system", text: "hello", timestamp: START_MS + 1000, speakerName: "Alex" },
  ], payload);
  assert.equal(merged[0].id, id);
});

test("a bleed-flagged mic segment that duplicates system text never keeps its epoch timestamp", async () => {
  const payload = await runMainDiarization(stripIds(liveWithEcho));
  const merged = runRendererCompletion(liveWithEcho, payload);

  assertNoEpochTimestamps(merged);
  assert.deepEqual(rows(merged), [
    ["mic", "morning everyone"],
    ["system", echoed],
  ]);
  assert.ok(merged.every((segment) => segment.speaker));
});

const racing = "sounds good to me";
// During disconnect a system final retracted seg-2 in main; the retract event
// arrived after the renderer's stop and was ignored.
const liveWithLateRetract = [
  { id: "seg-1", source: "system", text: "any objections", timestamp: START_MS + 1000 },
  { id: "seg-2", source: "mic", text: racing, timestamp: START_MS + 4000 },
];
const mainAfterLateRetract = [
  { source: "system", text: "any objections", timestamp: START_MS + 1000 },
  { source: "system", text: racing, timestamp: START_MS + 4500 },
];
const lateRetracts = [{ source: "mic", text: racing, timestamp: START_MS + 4000 }];

test("a mic segment retracted after the renderer stopped listening is removed from the note", async () => {
  const payload = await runMainDiarization(mainAfterLateRetract, { retracted: lateRetracts });
  const merged = runRendererCompletion(liveWithLateRetract, payload);

  assertNoEpochTimestamps(merged);
  assert.deepEqual(rows(merged), [
    ["system", "any objections"],
    ["system", racing],
  ]);
});

for (const outcome of ["skipped", "failed"]) {
  test(`${outcome} diarization still drops echo duplicates and late retracts`, async () => {
    const echoPayload = await runMainDiarization(stripIds(liveWithEcho), { outcome });
    assert.deepEqual(rows(runRendererCompletion(liveWithEcho, echoPayload)), [
      ["mic", "morning everyone"],
      ["system", echoed],
    ]);

    const retractPayload = await runMainDiarization(mainAfterLateRetract, {
      retracted: lateRetracts,
      outcome,
    });
    assert.deepEqual(rows(runRendererCompletion(liveWithLateRetract, retractPayload)), [
      ["system", "any objections"],
      ["system", racing],
    ]);
  });
}

test("a resumed note's earlier rows are never removed, even with the same key", async () => {
  // An earlier session's row that happens to share the echo row's key.
  const seed = [{ id: "old-1", source: "mic", text: echoed, timestamp: START_MS + 11000 }];
  const payload = await runMainDiarization(stripIds(liveWithEcho));
  const merged = runRendererCompletion(liveWithEcho, payload, seed);

  assert.deepEqual(rows(merged), [
    ["mic", echoed],
    ["mic", "morning everyone"],
    ["system", echoed],
  ]);
  assert.equal(merged[0].timestamp, START_MS + 11000);
});

test("post-session mic dedupe only looks at system text within 6 seconds", () => {
  const manager = new DiarizationManager();
  const repeated = "can everyone see my screen";
  const system = { source: "system", text: repeated, timestamp: 30 };
  const nearEcho = { source: "mic", text: repeated, timestamp: 33, hasBleedEvidence: true };
  // Said again 10 minutes later: real speech, not an echo.
  const later = { source: "mic", text: repeated, timestamp: 630, hasBleedEvidence: true };

  const { kept, removed } = manager.splitMicEchoDuplicates([system, nearEcho, later]);

  assert.deepEqual(removed, [nearEcho]);
  assert.deepEqual(kept, [system, later]);
});
