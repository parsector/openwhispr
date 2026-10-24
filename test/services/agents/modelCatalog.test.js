const test = require("node:test");
const assert = require("node:assert/strict");
const { claudeModels, validateModel } = require("../../../src/services/agents/modelCatalog");

test("Claude catalog accepts its aliases and pinned names", () => {
  const models = claudeModels();
  assert.deepEqual(
    models.aliases.map(({ id }) => id),
    ["opus", "sonnet", "haiku", "fable"]
  );
  for (const { id } of [...models.aliases, ...models.fullNames])
    assert.deepEqual(validateModel("claude", id), { ok: true, reason: null });
});

test("Claude model validation warns about mistaken aliases but permits future full names", () => {
  assert.deepEqual(validateModel("claude", ""), { ok: true, reason: null });
  assert.deepEqual(validateModel("claude", "opus-5-5"), { ok: false, reason: "unknown_alias" });
  assert.deepEqual(validateModel("claude", "???"), { ok: false, reason: "malformed" });
  assert.deepEqual(validateModel("claude", "garbage"), { ok: false, reason: "malformed" });
  assert.deepEqual(validateModel("claude", "claude-next-7.2"), { ok: true, reason: null });
  for (const id of ["claude-opus-4-6", "claude-sonnet-4-5", "claude-haiku-4-5"])
    assert.deepEqual(validateModel("claude", id), { ok: true, reason: null });
  assert.deepEqual(validateModel("cursor-agent", "custom-model"), { ok: true, reason: null });
  assert.deepEqual(validateModel("other", "opus"), { ok: false, reason: "unsupported" });
});
