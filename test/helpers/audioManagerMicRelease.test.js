const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");
const { installMicCaptureGlobals } = require("../lib/rendererTestHarness");
const { EventEmitter } = require("node:events");
const { createMicrophoneCaptureOwner } = require("../../src/helpers/microphoneCaptureOwner");
const { deferred } = require("./harness/deferred");

test("a cancelled preparation cannot release a newer prepared microphone", async (t) => {
  installMicCaptureGlobals(t);
  const { AudioManager, window } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-stale-prepare-",
    settingsKey: "__stalePrepareSettings",
    settings: {},
  });
  const owner = createMicrophoneCaptureOwner();
  const sender = new EventEmitter();
  window.electronAPI.acquireMicrophoneCapture = (id) => owner.acquire(sender, id);
  window.electronAPI.releaseMicrophoneCapture = (id) => owner.release(sender, id);
  navigator.mediaDevices.getUserMedia = async () => {
    const track = {
      readyState: "live",
      stop() {
        this.readyState = "ended";
      },
    };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  const manager = new AudioManager();
  const constraints = deferred();
  manager.isRecordingAllowedByPolicy = () => true;
  manager.shouldUseStreaming = () => true;
  manager._startPcmTap = () => null;
  let requests = 0;
  manager.getAudioConstraints = async () => {
    if (++requests === 1) await constraints.promise;
    return { audio: true };
  };
  try {
    const stale = manager.prepareMicCapture();
    await new Promise(setImmediate);
    manager.cancelPreparedMicCapture();
    const current = await manager.prepareMicCapture();
    assert.equal(current.stream.getTracks()[0].readyState, "live");
    constraints.resolve();
    assert.equal(await stale, null);
    await manager.microphoneCapture.releasing;
    assert.equal(current.stream.getTracks()[0].readyState, "live");
    assert.equal(manager.preparedMicCapture.prepared, current);
    assert.equal(owner.acquire(new EventEmitter(), "contender"), false);
    assert.equal(await manager.preparedMicCapture.take(), current);
  } finally {
    constraints.resolve();
    manager.cleanup();
  }
});

for (const action of ["stopRecording", "cancelRecording"]) {
  for (const pending of ["none", "constraints", "input", "fallback"]) {
    test(
      `${action} releases a dead recorder during recovery (${pending})`,
      { timeout: 15_000 },
      async (t) => {
        installMicCaptureGlobals(t);
        const { AudioManager, window } = await loadAudioManager(t, {
          cachePrefix: "openwhispr-recovery-release-",
          settingsKey: "__recoveryReleaseSettings",
          settings: {},
        });
        const admission = createMicrophoneCaptureOwner();
        const sender = new EventEmitter();
        window.electronAPI.acquireMicrophoneCapture = (id) => admission.acquire(sender, id);
        window.electronAPI.releaseMicrophoneCapture = (id) => admission.release(sender, id);
        const streams = [];
        let unblock;
        const gate = new Promise((resolve) => {
          unblock = resolve;
        });
        let opens = 0;
        navigator.mediaDevices.getUserMedia = async () => {
          opens++;
          if (pending === "fallback" && opens === 2) throw new Error("device removed");
          if (pending === "input" && opens === 2) await gate;
          const track = {
            readyState: "live",
            getSettings: () => ({}),
            stop() {
              this.readyState = "ended";
            },
          };
          const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
          streams.push(stream);
          return stream;
        };
        const manager = new AudioManager();
        try {
          const initial = await manager._acquireCaptureStream({ audio: {} });
          // A recorder whose input dies banks its segment while recovery retains admission.
          manager.isRecording = true;
          manager.createBatchRecorder(initial, {
            recorder: { state: "inactive", mimeType: "audio/webm" },
            chunks: [],
          });
          await manager.micRecovery.start(initial);
          manager.getAudioConstraints = async (fallback) => {
            if (pending === "constraints" || (pending === "fallback" && fallback)) await gate;
            return { audio: {} };
          };
          // Run the actual onstop handler, which starts the real recovery controller.
          await manager.mediaRecorder.onstop();
          await new Promise(setImmediate);
          const recovery = manager.micRecovery.recoveryPromise;
          assert.equal(admission.acquire(new EventEmitter(), "other"), false);
          assert.equal(manager[action](), true);
          assert.ok(
            streams.every((stream) => stream.getTracks()[0].readyState === "ended"),
            "Stop/Cancel must synchronously end every input already returned"
          );
          if (pending !== "none") {
            assert.equal(
              admission.acquire(new EventEmitter(), "too-early"),
              false,
              "admission stays reserved until a pending acquisition settles"
            );
          }
          unblock();
          await recovery;
          await manager.microphoneCapture.releasing;
          assert.ok(streams.every((stream) => stream.getTracks()[0].readyState === "ended"));
          assert.equal(
            admission.acquire(new EventEmitter(), "next-take"),
            true,
            "Stop/Cancel must leave admission available even when recovery settles late"
          );
          if (pending === "constraints")
            assert.equal(opens, 1, "stopped recovery cannot open input");
          if (pending === "fallback")
            assert.equal(opens, 2, "stopped recovery cannot open fallback input");
        } finally {
          unblock();
          manager.cleanup();
        }
      }
    );
  }
}

for (const action of ["stopRecording", "cancelRecording"]) {
  test(
    `${action} releases input and admission when recorder.stop throws`,
    { timeout: 15_000 },
    async (t) => {
      installMicCaptureGlobals(t);
      const { AudioManager, window } = await loadAudioManager(t, {
        cachePrefix: "openwhispr-stop-error-",
        settingsKey: "__stopErrorSettings",
        settings: {},
      });
      const admission = createMicrophoneCaptureOwner();
      const sender = new EventEmitter();
      window.electronAPI.acquireMicrophoneCapture = (id) => admission.acquire(sender, id);
      window.electronAPI.releaseMicrophoneCapture = (id) => admission.release(sender, id);
      const manager = new AudioManager();
      try {
        const stream = await navigator.mediaDevices.getUserMedia();
        const track = stream.getTracks()[0];
        track.stop = () => {
          track.readyState = "ended";
        };
        await manager._acquireCaptureStream({ audio: {} });
        manager.isRecording = true;
        manager.mediaRecorder = {
          state: "recording",
          stream,
          stop() {
            throw new Error("recorder gone");
          },
        };
        assert.equal(manager[action](), true);
        await manager.microphoneCapture.releasing;
        assert.equal(track.readyState, "ended");
        assert.equal(admission.acquire(new EventEmitter(), "next-take"), true);
      } finally {
        manager.cleanup();
      }
    }
  );
}

test("legacy warm-hold settings cannot retain the microphone after a take", async (t) => {
  installMicCaptureGlobals(t);
  const { AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-mic-release-",
    settingsKey: "__micReleaseSettings",
    settings: { micWarmHoldSeconds: 900 },
  });
  const stream = await navigator.mediaDevices.getUserMedia();
  const track = stream.getTracks()[0];
  track.stop = function () {
    this.readyState = "ended";
  };
  track.clone = () => ({ ...track });
  const previousMediaStream = globalThis.MediaStream;
  globalThis.MediaStream = class {
    constructor(tracks) {
      this.tracks = tracks;
    }
    getTracks() {
      return this.tracks;
    }
    getAudioTracks() {
      return this.tracks;
    }
  };
  t.after(() => {
    if (previousMediaStream === undefined) delete globalThis.MediaStream;
    else globalThis.MediaStream = previousMediaStream;
  });
  const manager = new AudioManager();
  try {
    const captured = await manager._acquireCaptureStream({ audio: {} });
    captured.getTracks().forEach((input) => input.stop());
    manager._markCaptureStreamReleased();
    await manager.microphoneCapture?.releasing;
    assert.equal(track.readyState, "ended", "the original input must stop along with the take");
  } finally {
    manager.cleanup();
  }
});

test("streaming connection warmup never opens input while idle", async (t) => {
  installMicCaptureGlobals(t);
  const { AudioManager, window } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-mic-warmup-release-",
    settingsKey: "__micWarmupReleaseSettings",
    settings: {},
  });
  window.electronAPI.deepgramStreamingWarmup = async () => ({ success: true });
  const manager = new AudioManager();
  manager.isRecordingAllowedByPolicy = () => true;
  manager.shouldUseStreaming = () => true;
  manager.getStreamingProviderName = () => "deepgram";
  manager.cacheMicrophoneDeviceId = async () => {};
  manager.getKeyterms = () => [];
  manager.getOrCreateAudioContext = async () => ({ audioWorklet: { addModule: async () => {} } });
  manager.getWorkletBlobUrl = () => "worklet";
  let opens = 0;
  navigator.mediaDevices.getUserMedia = async () => {
    opens++;
    throw new Error("idle input open");
  };
  try {
    assert.equal(await manager.warmupStreamingConnection(), true);
    assert.equal(opens, 0);
  } finally {
    manager.cleanup();
  }
});

test("a failed recorder start releases its input and reservation", async (t) => {
  installMicCaptureGlobals(t);
  const { AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-mic-start-error-",
    settingsKey: "__micStartErrorSettings",
    settings: {},
  });
  const stream = await navigator.mediaDevices.getUserMedia();
  const track = stream.getTracks()[0];
  track.stop = () => {
    track.readyState = "ended";
  };
  navigator.mediaDevices.getUserMedia = async () => stream;
  const manager = new AudioManager();
  manager.isRecordingAllowedByPolicy = () => true;
  manager.getAudioConstraints = async () => ({ audio: {} });
  manager._startPcmTap = () => null;
  manager.createBatchRecorder = () => {
    throw new Error("recorder start failed");
  };
  try {
    assert.equal(await manager.startRecording(), false);
    await manager.microphoneCapture?.releasing;
    assert.equal(track.readyState, "ended");
    assert.equal(manager.microphoneCapture?.current, null);
  } finally {
    manager.teardownSpeechGate();
    manager.cleanup();
  }
});

test("closing during a muted-track health check stops input and cannot reopen it", async (t) => {
  installMicCaptureGlobals(t);
  const { AudioManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-mic-health-release-",
    settingsKey: "__micHealthReleaseSettings",
    settings: {},
  });
  const stream = await navigator.mediaDevices.getUserMedia();
  const track = stream.getTracks()[0];
  track.muted = true;
  track.addEventListener = () => {};
  track.removeEventListener = () => {};
  track.stop = () => {
    track.readyState = "ended";
  };
  let opens = 0;
  navigator.mediaDevices.getUserMedia = async () => {
    opens++;
    return stream;
  };
  const manager = new AudioManager();
  try {
    const opening = manager._acquireCaptureStream({ audio: {} });
    await new Promise(setImmediate);
    const stopped = manager.microphoneCapture.release();
    assert.equal(track.readyState, "ended");
    await assert.rejects(opening, /cancelled/);
    await stopped;
    assert.equal(opens, 1, "a stopped health check cannot retry input acquisition");
  } finally {
    manager.cleanup();
  }
});
