const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createMicrophoneCaptureOwner } = require("../../src/helpers/microphoneCaptureOwner");

test("a meeting excludes dictation, agent capture and permission probes until explicit release", () => {
  const owner = createMicrophoneCaptureOwner();
  const meeting = new EventEmitter();
  const dictation = new EventEmitter();
  assert.equal(owner.acquire(meeting, "meeting"), true);
  assert.equal(owner.acquire(meeting, "meeting"), true);
  assert.equal(owner.acquire(dictation, "dictation"), false);
  assert.equal(owner.acquire(new EventEmitter(), "agent"), false);
  assert.equal(owner.acquire(meeting, "permission-probe"), false);
  assert.equal(owner.release(dictation, "meeting"), false);
  assert.equal(owner.release(meeting, "stale-meeting"), false);
  assert.equal(owner.release(meeting, "meeting"), true);
  assert.equal(owner.acquire(dictation, "dictation"), true);
});

for (const event of ["destroyed", "render-process-gone"]) {
  test(`owner loss releases capture on ${event}`, () => {
    const owner = createMicrophoneCaptureOwner();
    const sender = new EventEmitter();
    owner.acquire(sender, "meeting");
    sender.emit(event, { isMainFrame: true, isSameDocument: false });
    assert.equal(owner.acquire(new EventEmitter(), "dictation"), true);
    assert.equal(sender.listenerCount("destroyed"), 0);
  });
}

test("navigation holds admission until committed-document teardown is signalled", () => {
  const owner = createMicrophoneCaptureOwner();
  const sender = new EventEmitter();
  const contender = new EventEmitter();
  owner.acquire(sender, "meeting");
  sender.emit("did-start-navigation", {}, "https://example.com/next", false, true);
  assert.equal(owner.acquire(contender, "dictation"), false);
  // This unit test models Electron's committed-document signal. Real track
  // destruction is verified separately in test/browser/microphoneNavigation.cjs.
  sender.emit("did-navigate", {}, "https://example.com/next");
  assert.equal(owner.acquire(contender, "dictation"), true);
  assert.equal(sender.listenerCount("did-navigate"), 0);
});

test("aborted navigation retains admission for the existing document", () => {
  const owner = createMicrophoneCaptureOwner();
  const sender = new EventEmitter();
  owner.acquire(sender, "meeting");
  sender.emit("did-start-navigation", {}, "https://example.com/pending", false, true);
  sender.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://example.com/pending", true);
  sender.emit("did-stop-loading");
  assert.equal(owner.acquire(new EventEmitter(), "dictation"), false);
  assert.equal(owner.acquire(sender, "meeting"), true);
  assert.equal(owner.release(sender, "meeting"), true);
  assert.equal(owner.acquire(new EventEmitter(), "dictation"), true);
});

test("same-document navigation preserves the recording reservation", () => {
  const owner = createMicrophoneCaptureOwner();
  const sender = new EventEmitter();
  owner.acquire(sender, "meeting");
  sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  assert.equal(owner.acquire(new EventEmitter(), "agent"), false);
});
