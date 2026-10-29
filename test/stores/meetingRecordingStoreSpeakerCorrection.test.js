const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

test("a live row appended during correction IPC survives the committed store update", async (t) => {
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, { window: { electronAPI: {}, setTimeout } });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-speaker-correction-store-",
  });
  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const initial = { id: "a", text: "first", source: "system", speaker: "speaker_0" };
  const late = { id: "late", text: "arrived during IPC", source: "system", speaker: "speaker_0" };
  store.useMeetingRecordingStore.setState({ segments: [initial] });
  const committed = { ...initial, speakerName: "Alex", speakerLocked: true };
  store.useMeetingRecordingStore.setState({ segments: [initial, late] });
  store.mergeCommittedSpeakerRows([committed]);
  assert.deepEqual(
    store.useMeetingRecordingStore.getState().segments.map((r) => r.id),
    ["a", "late"]
  );
  assert.equal(store.useMeetingRecordingStore.getState().segments[0].speakerName, "Alex");
});
