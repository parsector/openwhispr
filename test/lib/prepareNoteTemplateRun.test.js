const test = require("node:test");
const assert = require("node:assert/strict");

test("pending enhanced save completes before a template run may write", async () => {
  const { prepareNoteTemplateRun } = await import("../../src/lib/prepareNoteTemplateRun.ts");
  const writes = [];
  let release;
  const pendingSave = new Promise((resolve) => {
    release = resolve;
  });
  const preparing = prepareNoteTemplateRun({
    flush: async () => {
      await pendingSave;
      writes.push("saved pending summary");
    },
    isTemplate: true,
    summary: null,
    storedHash: null,
    handEditConfirmed: false,
    requestConfirmation: () => assert.fail("no summary to confirm"),
    reportSaveError: () => assert.fail("save succeeded"),
  });
  assert.deepEqual(writes, []);
  release();
  assert.equal(await preparing, true);
  writes.push("runner write");
  assert.deepEqual(writes, ["saved pending summary", "runner write"]);
});

test("only a hand-edited summary asks for confirmation; cancel and save failure prevent the run", async () => {
  const { prepareNoteTemplateRun } = await import("../../src/lib/prepareNoteTemplateRun.ts");
  const { withSummaryHash } = await import("../../src/lib/noteSummaryHash.ts");
  const events = [];
  const options = {
    flush: async () => events.push("flush"),
    isTemplate: true,
    summary: "Generated",
    storedHash: withSummaryHash("source", "Generated"),
    handEditConfirmed: false,
    requestConfirmation: () => events.push("confirm"),
    reportSaveError: () => events.push("error"),
  };
  assert.equal(await prepareNoteTemplateRun(options), true);
  assert.deepEqual(events, ["flush"]);
  events.length = 0;
  assert.equal(await prepareNoteTemplateRun({ ...options, summary: "Hand edited" }), false);
  assert.deepEqual(events, ["flush", "confirm"]);
  // Cancel never invokes the run again, leaving the saved edited summary in place.
  events.length = 0;
  assert.equal(await prepareNoteTemplateRun({ ...options, summary: null }), true);
  assert.deepEqual(events, ["flush"]);
  events.length = 0;
  assert.equal(
    await prepareNoteTemplateRun({
      ...options,
      flush: async () => {
        throw new Error("disk full");
      },
    }),
    false
  );
  assert.deepEqual(events, ["error"]);
});
