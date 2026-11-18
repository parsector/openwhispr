const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
for (const model of ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "groq/compound", "groq/compound-mini"])
 test(`startup preserves saved Groq model ${model} even when absent from this build`, async t => {
   const { storage } = installBrowserGlobals(t, { initialStorage: {
     _llmScopeKeysMigrated: "1", cleanupMode: "providers", cleanupProvider: "groq", cleanupModel: model,
     dictationAgentMode: "providers", dictationAgentProvider: "groq", dictationAgentModel: model,
   } });
   const vite = await createRendererServer(t);
   const { useSettingsStore, reconcileRetiredCloudModelSelections } = await vite.ssrLoadModule("/stores/settingsStore.ts");
   reconcileRetiredCloudModelSelections();
   assert.equal(useSettingsStore.getState().cleanupModel, model);
   assert.equal(useSettingsStore.getState().dictationAgentModel, model);
   assert.equal(storage.getItem("cleanupModel"), model);
   const { consumeRetiredModelSwitches } = await vite.ssrLoadModule("/stores/retiredModelSwitchStore.ts");
   assert.deepEqual(consumeRetiredModelSwitches(), []);
 });
