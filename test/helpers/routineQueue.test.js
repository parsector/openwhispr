const test = require("node:test");
const assert = require("node:assert/strict");
const { RoutineQueue } = require("../../src/helpers/routines/routineQueue");

test("catch-up joins a claimed slot while manual keys remain independent", async () => {
  const calls = [];
  const queue = new RoutineQueue({
    run: async (job) => {
      calls.push(job.slotKey);
      return job.slotKey;
    },
  });
  const first = queue.enqueue({ routineId: "a", slotKey: "2026-10-25 09:00", catchUp: true });
  const joined = queue.enqueue({ routineId: "a", slotKey: "2026-10-25 09:00", catchUp: true });
  assert.equal(first, joined);
  await Promise.all([
    first,
    queue.enqueue({ routineId: "a", slotKey: "manual:one" }),
    queue.enqueue({ routineId: "a", slotKey: "manual:two" }),
  ]);
  assert.deepEqual(calls, ["2026-10-25 09:00", "manual:one", "manual:two"]);
});

test("at most two distinct routines run and same-routine work serializes", async () => {
  let active = 0;
  let peak = 0;
  const releases = [];
  const queue = new RoutineQueue({
    run: () =>
      new Promise((resolve) => {
        active++;
        peak = Math.max(active, peak);
        releases.push(() => {
          active--;
          resolve();
        });
      }),
  });
  const jobs = ["a", "a", "b", "c"].map((id, index) =>
    queue.enqueue({ routineId: id, slotKey: `manual:${index}` })
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  while (releases.length) {
    releases.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(jobs);
  assert.equal(peak, 2);
});

test("recording delays local indefinitely, permits cloud after 60 minutes, and skips expired local catch-up", async () => {
  let now = 0;
  let recording = true;
  const calls = [];
  const queue = new RoutineQueue({
    now: () => now,
    isRecording: () => recording,
    run: async (job) => {
      calls.push(job.slotKey);
      return { status: "done" };
    },
  });
  const local = queue.enqueue({
    routineId: "a",
    slotKey: "local",
    localModel: true,
    catchUp: true,
    expiresAt: 100,
  });
  const cloud = queue.enqueue({ routineId: "b", slotKey: "cloud", localModel: false });
  now = 3600001;
  queue.drain();
  assert.equal((await cloud).status, "done");
  assert.deepEqual(calls, ["cloud"]);
  recording = false;
  queue.recordingStopped();
  assert.deepEqual(await local, { status: "skipped", reason: "recording" });
});
