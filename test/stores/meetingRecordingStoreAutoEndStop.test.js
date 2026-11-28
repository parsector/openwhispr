const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createMicrophoneCaptureOwner } = require("../../src/helpers/microphoneCaptureOwner");
const { deferred } = require("../helpers/harness/deferred");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// `stopped` is true only when this call ended a live recording. It must not be
// conditioned on main's teardown result — the transcript is written from the
// renderer before that IPC is even awaited, so a teardown error still leaves a
// persisted note.

const START_ARGS = {
  noteId: 11,
  noteTitle: "Standup",
  folderId: null,
  autoEndEligible: true,
};

function createElectronAPI({ stopResult }) {
  const noopListener = () => () => {};
  const notes = new Map([[11, { id: 11, transcript: "", deleted_at: null }]]);
  return {
    api: {
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
      meetingTranscriptionStop: async () => stopResult(),
      meetingTranscriptionSend: () => {},
      getNote: async (id) => notes.get(id) ?? null,
      updateNote: async () => ({ success: true }),
      onMeetingTranscriptionSegment: noopListener,
      onMeetingSpeakerIdentified: noopListener,
      onMeetingSpeakersMerged: noopListener,
      onMeetingSessionSpeakerConfigUpdated: noopListener,
      onMeetingTranscriptionError: noopListener,
      onMeetingTranscriptionFatalError: noopListener,
      onMeetingSystemAudioSilent: noopListener,
      onMeetingDiarizationComplete: noopListener,
    },
  };
}

async function loadStore(t, api) {
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, {
    window: { electronAPI: api, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-auto-end-stop-test-",
  });
  return vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
}

for (const pending of ["constraints", "input", "fallback"]) {
  test(
    `meeting recovery cannot open input after Stop (${pending})`,
    { timeout: 15_000 },
    async (t) => {
      const owner = createMicrophoneCaptureOwner();
      const sender = new EventEmitter();
      const contender = new EventEmitter();
      let mainStops = 0;
      const { api } = createElectronAPI({
        stopResult: () => {
          mainStops++;
          return { success: true };
        },
      });
      api.acquireMicrophoneCapture = (id) => owner.acquire(sender, id);
      api.releaseMicrophoneCapture = (id) => owner.release(sender, id);
      const store = await loadStore(t, api);
      const gate = deferred();
      const reached = deferred();
      let recover = false;
      let stopped = false;
      let opensAfterStop = 0;
      const tracks = [];
      const ended = new EventEmitter();
      navigator.mediaDevices.enumerateDevices = async () => {
        if (recover && pending === "constraints") {
          reached.resolve();
          await gate.promise;
        }
        return [];
      };
      navigator.mediaDevices.getUserMedia = async () => {
        if (stopped) opensAfterStop++;
        if (recover && pending !== "constraints") {
          reached.resolve();
          await gate.promise;
          if (pending === "fallback") throw new Error("device removed");
        }
        const track = {
          readyState: "live",
          getSettings: () => ({}),
          stop() {
            this.readyState = "ended";
          },
          addEventListener: (event, fn) => ended.on(event, fn),
          removeEventListener: (event, fn) => ended.off(event, fn),
        };
        tracks.push(track);
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      };
      try {
        assert.equal(await store.startRecording(START_ARGS), true);
        recover = true;
        tracks[0].readyState = "ended";
        ended.emit("ended");
        await reached.promise;
        const stopping = store.stopRecording();
        stopped = true;
        if (pending === "constraints") {
          let deadline;
          try {
            await Promise.race([
              stopping,
              new Promise((_, reject) => {
                deadline = setTimeout(
                  () => reject(new Error("Stop waited for recovery constraints")),
                  1000
                );
              }),
            ]);
          } finally {
            clearTimeout(deadline);
          }
          assert.equal(
            owner.acquire(contender, "next"),
            true,
            "a device lookup cannot delay admission release"
          );
        }
        gate.resolve();
        await stopping;
        await new Promise(setImmediate);
        assert.equal(
          opensAfterStop,
          0,
          "neither primary nor fallback may request hardware after Stop"
        );
        assert.equal(mainStops, 1);
        assert.ok(tracks.every((track) => track.readyState === "ended"));
        assert.equal(owner.acquire(contender, "next"), true);
      } finally {
        gate.resolve();
        await store.stopRecording();
      }
    }
  );
}

test("a live meeting excludes another microphone owner before getUserMedia", async (t) => {
  const owner = createMicrophoneCaptureOwner();
  const sender = new EventEmitter();
  const { api } = createElectronAPI({ stopResult: () => ({ success: true }) });
  api.acquireMicrophoneCapture = async (id) => owner.acquire(sender, id);
  api.releaseMicrophoneCapture = async (id) => owner.release(sender, id);
  const store = await loadStore(t, api);
  assert.equal(await store.startRecording(START_ARGS), true);
  const { MicrophoneCapture } = await import("../../src/helpers/microphoneCapture.js");
  const dictation = new MicrophoneCapture();
  let opens = 0;
  await assert.rejects(
    dictation.open(async () => {
      opens++;
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }),
    /already in use/
  );
  assert.equal(opens, 0);
  await store.stopRecording();
  await dictation.open(() => navigator.mediaDevices.getUserMedia({ audio: true }));
  await dictation.release();
});

test("a directly resumed note carries its calendar identity into the recording session", async (t) => {
  const { api } = createElectronAPI({ stopResult: () => ({ success: true }) });
  api.getNote = async () => ({ id: 11, transcript: "", calendar_event_id: "calendar-event" });
  const start = api.meetingTranscriptionStart;
  let startedOptions;
  api.meetingTranscriptionStart = async (options) => {
    startedOptions = options;
    return start(options);
  };
  const store = await loadStore(t, api);
  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(startedOptions.calendarEventId, "calendar-event");
  await store.stopRecording();
});

test("a completed stop reports that it ended the recording", async (t) => {
  const { api } = createElectronAPI({ stopResult: () => ({ success: true }) });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  const result = await store.stopRecording();

  assert.equal(result.stopped, true);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
});

for (const stopError of [false, true]) {
  test(`meeting close releases the mic even with disconnect error=${stopError}`, async (t) => {
    let mainStops = 0;
    const { api } = createElectronAPI({
      stopResult: () => {
        mainStops++;
        return { success: true };
      },
    });
    const store = await loadStore(t, api);
    const stream = await navigator.mediaDevices.getUserMedia();
    const track = stream.getTracks()[0];
    track.stop = () => {
      track.readyState = "ended";
    };
    if (stopError)
      globalThis.AudioWorkletNode.prototype.disconnect = () => {
        throw new Error("graph gone");
      };
    assert.equal(await store.startRecording(START_ARGS), true);
    await store.stopRecording();
    assert.equal(track.readyState, "ended");
    assert.equal(mainStops, 1, "renderer teardown errors must still stop main capture");
    assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
  });
}

// The note header's timer derives its elapsed seconds from this stamp instead of
// counting ticks, so a note switch (which remounts the editor) keeps the real
// duration rather than restarting at 00:00.
test("a session stamps its start time and clears it on stop", async (t) => {
  const { api } = createElectronAPI({ stopResult: () => ({ success: true }) });
  const store = await loadStore(t, api);
  const beforeStart = Date.now();

  assert.equal(await store.startRecording(START_ARGS), true);
  const startedAt = store.useMeetingRecordingStore.getState().recordingStartedAt;
  assert.equal(typeof startedAt, "number");
  assert.ok(startedAt >= beforeStart, "the stamp is the moment recording began");

  await store.stopRecording();

  assert.equal(store.useMeetingRecordingStore.getState().recordingStartedAt, null);
});

// The renderer has already run cleanup and written the transcript by the time
// main's result is read, so a teardown failure must not be reported as a
// recording that never stopped.
test("a stop whose main-side teardown fails still reports the recording ended", async (t) => {
  const { api } = createElectronAPI({
    stopResult: () => ({ success: false, error: "audio tap teardown failed" }),
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  const result = await store.stopRecording();

  assert.equal(result.stopped, true);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
});

test("a stop main already dropped as stale still reports the recording ended", async (t) => {
  const { api } = createElectronAPI({
    stopResult: () => ({ success: false, reason: "stale-session" }),
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal((await store.stopRecording()).stopped, true);
});

test("a stop that rejects still reports the recording ended", async (t) => {
  const { api } = createElectronAPI({
    stopResult: () => {
      throw new Error("ipc channel closed");
    },
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal((await store.stopRecording()).stopped, true);
});

test("stopping when nothing is recording reports no stop happened", async (t) => {
  const { api } = createElectronAPI({ stopResult: () => ({ success: true }) });
  const store = await loadStore(t, api);

  assert.equal((await store.stopRecording()).stopped, false);
});

test("a scoped stop for another session reports no stop happened", async (t) => {
  const { api } = createElectronAPI({ stopResult: () => ({ success: true }) });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  const result = await store.stopRecording("some-other-session");

  assert.equal(result.stopped, false);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, true);
  await store.stopRecording();
});
