const test = require("node:test");
const assert = require("node:assert/strict");
const { parseDueDate } = require("../../src/helpers/commitments/parseDueDate");

const wed = new Date(2026, 9, 28, 15);
for (const [raw, expected] of [
  ["today", "2026-10-28"], ["tonight", "2026-10-28"],
  ["tomorrow", "2026-10-29"], ["Friday", "2026-10-30"],
  ["this Friday", "2026-10-30"], ["next Friday", "2026-10-30"],
  ["by Friday", "2026-10-30"], ["Monday", "2026-11-02"],
  ["Tuesday", "2026-11-03"], ["Wednesday", "2026-11-04"],
  ["Thursday", "2026-10-29"], ["Saturday", "2026-10-31"],
  ["Sunday", "2026-11-01"], ["end of month", "2026-10-31"],
  ["by the end of the month", "2026-10-31"],
  ["30/10", "2026-10-30"], ["2/11", "2026-11-02"],
  ["31/12", "2026-12-31"], ["1/1", "2027-01-01"],
  ["October 30", "2026-10-30"], ["November 2nd", "2026-11-02"],
  ["2 November", "2026-11-02"], ["December 1 2027", "2027-12-01"],
  ["31/2", null], ["soon", null], ["next week", null],
  ["sometime", null], ["later this quarter", null],
]) {
  test(`date phrase ${raw}`, () => {
    const parsed = parseDueDate(raw, wed);
    assert.equal(parsed?.due_date || null, expected);
    if (parsed) assert.equal(parsed.due_raw, raw);
  });
}

test("Friday said on Friday means the following Friday", () => {
  assert.equal(parseDueDate("this Friday", new Date(2026, 9, 30, 12)).due_date, "2026-11-06");
});

test("date uses local day at UTC boundary", () => {
  const instant = new Date("2026-10-29T00:30:00Z");
  const expected = new Date(instant.getFullYear(), instant.getMonth(), instant.getDate());
  assert.equal(parseDueDate("tonight", instant).due_date,
    `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, "0")}-${String(expected.getDate()).padStart(2, "0")}`);
});
