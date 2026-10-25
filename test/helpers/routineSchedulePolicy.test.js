const test = require("node:test");
const assert = require("node:assert/strict");
const {
  nextRun,
  latestCatchUp,
  slotKey,
  manualSlotKey,
  voiceSlotKey,
} = require("../../src/helpers/routines/routineSchedulePolicy");

const everyDay = (time) => ({ slots: [{ days: [0, 1, 2, 3, 4, 5, 6], time }] });

test("spring DST gap runs the missing slot once at the first valid local time", () => {
  const old = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const run = nextRun(everyDay("02:30"), new Date("2026-03-08T06:30:00Z"));
    assert.equal(run.slotKey, "2026-03-08 02:30");
    assert.equal(run.at.getHours(), 3);
    assert.equal(run.at.getMinutes(), 30);
  } finally {
    process.env.TZ = old;
  }
});

test("fall DST repeated hour uses one wall-clock slot key", () => {
  const old = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const run = nextRun(everyDay("01:30"), new Date("2026-11-01T04:30:00Z"));
    assert.equal(run.slotKey, "2026-11-01 01:30");
    assert.equal(run.at.toISOString(), "2026-11-01T05:30:00.000Z");
    assert.equal(
      latestCatchUp(everyDay("01:30"), new Date("2026-11-01T06:45:00Z"), 4).slotKey,
      run.slotKey
    );
  } finally {
    process.env.TZ = old;
  }
});

test("catch-up chooses only the latest slot in its window", () => {
  const config = {
    slots: [
      { days: [0, 1, 2, 3, 4, 5, 6], time: "08:00" },
      { days: [0, 1, 2, 3, 4, 5, 6], time: "10:00" },
    ],
  };
  const now = new Date(2026, 9, 25, 11, 0);
  assert.equal(latestCatchUp(config, now, 4).slotKey, "2026-10-25 10:00");
  assert.equal(latestCatchUp(config, now, 0.5), null);
});

test("time, manual and voice keys remain distinct", () => {
  assert.equal(slotKey(new Date(2026, 9, 25), "09:00"), "2026-10-25 09:00");
  assert.equal(manualSlotKey("one"), "manual:one");
  assert.equal(voiceSlotKey("one"), "voice:one");
});
