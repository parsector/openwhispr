const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseOpenPullRequests,
  createOpenPullRequests,
  ARGV,
} = require("../../../src/services/agents/openPullRequests");

test("parses, filters, sorts, and limits open pull requests", () => {
  assert.deepEqual(parseOpenPullRequests("[]"), []);
  assert.equal(parseOpenPullRequests("junk"), null);
  assert.equal(parseOpenPullRequests("{}"), null);
  const values = Array.from({ length: 25 }, (_, i) => ({
    number: 25 - i,
    title: `PR ${i}`,
    headRefName: `b${i}`,
  }));
  values.push({}, { number: 0 }, { number: -1 }, { number: 1.5 }, { number: "2" });
  const parsed = parseOpenPullRequests(JSON.stringify(values));
  assert.equal(parsed.length, 20);
  assert.deepEqual(
    parsed.map((item) => item.number),
    Array.from({ length: 20 }, (_, i) => i + 1)
  );
  assert.equal(parsed[0].title, "PR 24");
  assert.equal(parsed[0].headRefName, "b24");
});

test("enumerator reports missing gh and parse failures without spawning", async () => {
  let runs = 0;
  let resolutions = 0;
  const missing = createOpenPullRequests({
    resolver: {
      resolve: async () => {
        resolutions++;
        return { ok: false };
      },
    },
    runImpl: async () => {
      runs++;
    },
  });
  assert.deepEqual(await missing("/tmp"), { ok: false, reason: "gh_missing" });
  assert.deepEqual(await missing("/tmp"), { ok: false, reason: "gh_missing" });
  assert.equal(runs, 0);
  assert.equal(resolutions, 1);
  const enumerate = createOpenPullRequests({
    resolver: { resolve: async () => ({ ok: true, path: "/usr/bin/gh" }) },
    runImpl: async (binary, argv, options) => {
      runs++;
      assert.equal(binary, "/usr/bin/gh");
      assert.deepEqual(argv, ARGV);
      assert.equal(options.cwd, "/tmp");
      assert.equal(options.timeout, 5000);
      return { stdout: "not json" };
    },
  });
  assert.deepEqual(await enumerate("/tmp"), { ok: false, reason: "parse_failed" });
  assert.equal(runs, 1);
});
