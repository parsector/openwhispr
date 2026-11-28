const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createMicrophoneCaptureOwner } = require("../../src/helpers/microphoneCaptureOwner");
const { installBrowserGlobals, installMicCaptureGlobals } = require("../lib/rendererTestHarness");
const { deferred } = require("./harness/deferred");

async function setup(t) {
  const owner = createMicrophoneCaptureOwner();
  const sender = new EventEmitter();
  const events = new EventEmitter();
  installBrowserGlobals(t, {
    window: {
      addEventListener: (event, fn) => events.on(event, fn),
      removeEventListener: (event, fn) => events.off(event, fn),
      electronAPI: {
        acquireMicrophoneCapture: async (id) => owner.acquire(sender, id),
        releaseMicrophoneCapture: async (id) => owner.release(sender, id),
        onReleaseIdleMicrophone: (fn) => {
          events.on("hide", fn);
          return () => events.off("hide", fn);
        },
      },
    },
  });
  const { MicrophoneCapture } = await import("../../src/helpers/microphoneCapture.js");
  const track = {
    readyState: "live",
    stop() {
      this.readyState = "ended";
    },
  };
  const stream = { getTracks: () => [track] };
  return { MicrophoneCapture, owner, sender, events, stream, track };
}

test("a recording excludes another capture before it can open the device", async (t) => {
  const { MicrophoneCapture, stream, track } = await setup(t);
  const meeting = new MicrophoneCapture();
  const dictation = new MicrophoneCapture();
  await meeting.open(async () => stream);
  let opens = 0;
  await assert.rejects(
    dictation.open(async () => {
      opens++;
      return stream;
    }),
    /already in use/
  );
  assert.equal(opens, 0);
  await meeting.release();
  assert.equal(track.readyState, "ended");
  await dictation.open(async () => stream);
  await dictation.release();
});

test("close releases a late permission result and holds admission until it settles", async (t) => {
  const { MicrophoneCapture, owner, stream, track } = await setup(t);
  const permission = deferred();
  const capture = new MicrophoneCapture();
  const opening = capture.open(() => permission.promise);
  await new Promise(setImmediate);
  const released = capture.release();
  const next = new EventEmitter();
  assert.equal(owner.acquire(next, "next"), false);
  permission.resolve(stream);
  await assert.rejects(opening, /cancelled/);
  await released;
  assert.equal(track.readyState, "ended");
  assert.equal(owner.acquire(next, "next"), true);
});

for (const event of ["beforeunload", "hide"]) {
  test(`permission probe releases its tracks and reservation on ${event}`, async (t) => {
    const { MicrophoneCapture, owner, events, stream, track } = await setup(t);
    const capture = new MicrophoneCapture({ releaseOnHide: true });
    await capture.open(async () => stream);
    events.emit(event);
    assert.equal(track.readyState, "ended", "hardware release is synchronous");
    await capture.release();
    assert.equal(owner.acquire(new EventEmitter(), "next"), true);
    assert.equal(events.listenerCount("beforeunload"), 0);
    assert.equal(events.listenerCount("hide"), 0);
  });
}

test("a failed open releases admission and permits a retry", async (t) => {
  const { MicrophoneCapture, owner, stream } = await setup(t);
  const capture = new MicrophoneCapture();
  await assert.rejects(
    capture.open(async () => {
      throw new Error("device lost");
    }),
    /device lost/
  );
  await capture.release();
  await capture.open(async () => stream);
  assert.equal(owner.acquire(new EventEmitter(), "competing"), false);
  await capture.release();
});

test("a failed initial health check releases opened input and admission", async (t) => {
  installMicCaptureGlobals(t);
  const { MicrophoneCapture, owner, stream, track } = await setup(t);
  navigator.mediaDevices.getUserMedia = async () => stream;
  const capture = new MicrophoneCapture();
  await assert.rejects(
    capture.open(async (openInput) => {
      await openInput({ audio: true });
      throw new Error("health check failed");
    }),
    /health check failed/
  );
  await capture.releasing;
  assert.equal(track.readyState, "ended");
  assert.equal(owner.acquire(new EventEmitter(), "next"), true);
});

test("a failed recovery open preserves the current take's ownership", async (t) => {
  const { MicrophoneCapture, owner, stream, track } = await setup(t);
  const capture = new MicrophoneCapture();
  await capture.open(async () => stream);
  await assert.rejects(
    capture.open(async () => {
      throw new Error("recovery failed");
    }),
    /recovery failed/
  );
  assert.equal(track.readyState, "live");
  assert.equal(owner.acquire(new EventEmitter(), "next"), false);
  await capture.release();
});

test("scoped disposal releases admission despite ended inputs from a health retry", async (t) => {
  const { MicrophoneCapture, owner, stream, track } = await setup(t);
  const capture = new MicrophoneCapture();
  const deadInput = { getTracks: () => [{ readyState: "ended" }] };
  await capture.open(() => deadInput);
  await capture.open(() => stream);
  capture.releaseStream(stream);
  await capture.releasing;
  assert.equal(track.readyState, "ended");
  assert.equal(owner.acquire(new EventEmitter(), "next"), true);
});

test("a close in the opening turn cannot start capture in a later microtask", async (t) => {
  const { MicrophoneCapture, owner, stream } = await setup(t);
  const capture = new MicrophoneCapture();
  let opens = 0;
  const opening = capture.open(async () => {
    opens++;
    return stream;
  });
  const released = capture.release();
  await assert.rejects(opening, /cancelled/);
  await released;
  assert.equal(opens, 0);
  assert.equal(owner.acquire(new EventEmitter(), "next"), true);
});

test("release stops input after its window global has gone away", async (t) => {
  const { MicrophoneCapture, stream, track, owner } = await setup(t);
  const capture = new MicrophoneCapture();
  await capture.open(async () => stream);
  const acquisitionWindow = globalThis.window;
  delete globalThis.window;
  try {
    await capture.release();
    assert.equal(track.readyState, "ended");
    assert.equal(owner.acquire(new EventEmitter(), "next"), true);
  } finally {
    globalThis.window = acquisitionWindow;
  }
});
