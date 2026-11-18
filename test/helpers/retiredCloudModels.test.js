const test = require("node:test");
const assert = require("node:assert/strict");
const legacy = {
  tinfoil: ["glm-5-2", "glm-5-3-flash", "deepseek-v4-pro", "deepseek-v4-flash", "kimi-k2-6"],
  groq: ["qwen/qwen3-32b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant", "groq/compound", "groq/compound-mini"],
  openai: ["gpt-4.1-nano"],
  custom: ["any/typed-model"],
};
for (const [provider, models] of Object.entries(legacy)) for (const model of models)
  for (const markers of [{}, { _retiredTinfoilModelsMigrated3: "1", _retiredGroqModelsMigrated2: "1" }])
    test(`preserves ${provider}/${model} with ${Object.keys(markers).length} old migration markers`, async () => {
      const { sweepRetiredCloudModelSelections } = await import("../../src/config/retiredCloudModels.ts");
      const { resolveRetiredCloudModel } = await import("../../src/config/retiredCloudModelPolicy.js");
      const map = new Map(Object.entries({ ...markers, cleanupProvider: provider, cleanupModel: model }));
      const before = [...map];
      const storage = { getItem: key => map.get(key) ?? null, setItem() { throw new Error("No writes allowed"); } };
      assert.deepEqual(sweepRetiredCloudModelSelections(storage, [{ provider: "cleanupProvider", model: "cleanupModel" }]), []);
      assert.deepEqual([...map], before);
      assert.equal(resolveRetiredCloudModel(provider, model), model);
    });
