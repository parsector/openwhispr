const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const seed = require("../../src/models/modelRegistryData.json");
const shipped = seed.cloudProviders.find(p => p.id === "tinfoil").models.map(m => m.id);
const flash = { id: "glm-5-3-flash", name: "Flash", description: "", supportsThinking: true };
const other = { ...flash, id: "discovered-new" };

test("all configured scopes retain their saved choices offline and across restart", async t => {
 const { INFERENCE_SCOPES } = await import("../../src/config/inferenceScopes.ts");
 const initialStorage = { _llmScopeKeysMigrated: "1", _retiredTinfoilModelsMigrated: "1", _retiredTinfoilModelsMigrated2: "1" };
 for (const { storeKeys } of Object.values(INFERENCE_SCOPES)) {
   initialStorage[storeKeys.provider] = "tinfoil"; initialStorage[storeKeys.model] = flash.id; initialStorage[storeKeys.mode] = "providers";
 }
 const { storage } = installBrowserGlobals(t, { initialStorage });
 for (let launch = 0; launch < 2; launch++) {
   const vite = await createRendererServer(t);
   const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
   for (const { storeKeys } of Object.values(INFERENCE_SCOPES)) {
     assert.equal(useSettingsStore.getState()[storeKeys.model], flash.id);
     assert.equal(storage.getItem(storeKeys.model), flash.id);
   }
   const notices = await vite.ssrLoadModule("/stores/retiredModelSwitchStore.ts");
   assert.deepEqual(notices.consumeRetiredModelSwitches(), []);
 }
});

for (const cachedModels of [[flash], [other, flash]]) test("fresh discovery cache adds suggestions without deleting shipped choices", async t => {
 const fetchedAt = Date.now() - 1000;
 const { storage } = installBrowserGlobals(t, { initialStorage: {
   _llmScopeKeysMigrated: "1", tinfoilModels: JSON.stringify({ models: cachedModels, fetchedAt }),
   cleanupProvider: "tinfoil", cleanupMode: "providers", cleanupModel: flash.id,
 } });
 for (let windowIndex = 0; windowIndex < 2; windowIndex++) {
   const vite = await createRendererServer(t);
   const registry = await vite.ssrLoadModule("/models/ModelRegistry.ts");
   const discovery = await vite.ssrLoadModule("/models/tinfoilModels.ts");
   const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
   await discovery.refreshTinfoilModels();
   assert.deepEqual(registry.getTinfoilModels().map(m => m.id), [...shipped, ...cachedModels.map(m => m.id)]);
   assert.equal(settings.getSettings().cleanupModel, flash.id);
   assert.equal(JSON.parse(storage.getItem("tinfoilModels")).fetchedAt, fetchedAt);
 }
});

for (const response of [[other], [flash], null, [], "network-error"])
 test(`discovery response ${JSON.stringify(response)} never rewrites a saved selection`, async t => {
   installBrowserGlobals(t, { initialStorage: {
     _llmScopeKeysMigrated: "1", cleanupMode: "providers", cleanupProvider: "tinfoil", cleanupModel: "my-typed-model",
   }, window: { electronAPI: { getTinfoilChatModels: async () => { if(response === "network-error") throw new Error("offline"); return response; } } } });
   const vite = await createRendererServer(t);
   const discovery = await vite.ssrLoadModule("/models/tinfoilModels.ts");
   const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
   const registry = await vite.ssrLoadModule("/models/ModelRegistry.ts");
   if(Array.isArray(response) && response.length) await discovery.refreshTinfoilModels();
   else await assert.rejects(discovery.refreshTinfoilModels());
   assert.equal(settings.getSettings().cleanupModel, "my-typed-model");
   for (const id of shipped) assert.ok(registry.getTinfoilModels().some(m => m.id === id));
 });
