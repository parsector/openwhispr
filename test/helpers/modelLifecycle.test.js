const test = require("node:test");
const assert = require("node:assert/strict");
const seed = require("../../src/models/modelRegistryData.json");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("lifecycle and version fields cannot hide or redirect any fork-owned model", async () => {
 const store = await import("../../src/models/registryData.js");
 const { isModelSupported, selectCatalogForVersion } = await import("../../src/models/registrySelection.js");
 const { retiredReplacement, retiredLocalSpeechReplacement } = await import("../../src/models/modelLifecycle.js");
 const { resolveByokModel } = await import("../../src/helpers/transcriptionRoute.ts");
 const data = structuredClone(seed);
 for(const section of ["cloudProviders", "enterpriseProviders", "transcriptionProviders", "localProviders"])
   for(const provider of data[section]) for(const model of provider.models)
     Object.assign(model, { legacy: true, retired: true, minAppVersion: "999.0.0", replacement: "vendor-successor" });
 for(const section of ["whisperModels", "parakeetModels"])
   for(const model of Object.values(data[section])) Object.assign(model, { legacy: true, retired: true, minAppVersion: "999.0.0" });
 assert.deepEqual(selectCatalogForVersion(data, seed, "0.1.0"), data);
 store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 });
 for(const section of ["cloudProviders", "enterpriseProviders", "transcriptionProviders", "localProviders"])
   for(const provider of data[section]) {
     const actual = store.getRegistryData()[section].find(p => p.id === provider.id);
     assert.deepEqual(actual.models.map(m => m.id), provider.models.map(m => m.id));
     for(const model of provider.models) {
       assert.equal(isModelSupported(model, "0.1.0"), true);
       assert.equal(retiredReplacement(section, provider.id, model.id), null);
       if(section === "transcriptionProviders") assert.equal(resolveByokModel(provider.id, model.id), model.id);
     }
   }
 for(const section of ["whisperModels", "parakeetModels"]) for(const id of Object.keys(data[section])) {
   assert.ok(store.getRunnableSpeechModel(section, id));
   assert.equal(retiredLocalSpeechReplacement(section, id, () => true), null);
 }
 store.replaceRegistryData({ data: seed, manifestVersion: store.getRegistryVersion() + 1 });
});

for(const choice of [
 { provider: "openai", model: "gpt-5.5", mode: "providers" },
 { provider: "anthropic", model: "unlisted-personal-model", mode: "providers" },
 { provider: "qwen", model: "missing-local-gguf", mode: "local" },
 { provider: "bedrock", model: "eu.saved-deployment", mode: "enterprise" },
]) for (const pending of [true, false])
 test(`saved ${choice.mode}/${choice.model} survives reconciliation with pending=${pending}`, async t => {
   const { storage } = installBrowserGlobals(t, { initialStorage: {
     _llmScopeKeysMigrated: "1", _providerSettingsMigrated: "1",
     cleanupMode: choice.mode, cleanupProvider: choice.provider, cleanupModel: choice.model,
     whisperModel: "base", meetingWhisperModel: "base", uploadWhisperModel: "base",
     parakeetModel: "parakeet-tdt-0.6b-v3",
   }, window: { location: { search: "?panel=true" }, electronAPI: { modelGetAll: async () => [] } } });
   const vite = await createRendererServer(t);
   const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
   const store = await vite.ssrLoadModule("/models/registryData.js");
   const notices = await vite.ssrLoadModule("/stores/retiredModelSwitchStore.ts");
   const data = structuredClone(seed);
   data.whisperModels.base.retired = true;
   store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1, pending });
   settings.reconcileRetiredCloudModelSelections();
   await settings.reconcileRetiredLocalLlmSelections(new Set());
   await settings.reconcileRetiredLocalSpeechSelections();
   await settings.reconcileLocalModelSelections();
   settings.clearMissingLocalModelSelections(() => false);
   const state = settings.useSettingsStore.getState();
   assert.equal(state.cleanupModel, choice.model);
   assert.equal(storage.getItem("cleanupModel"), choice.model);
   for(const key of ["whisperModel", "meetingWhisperModel", "uploadWhisperModel"]) assert.equal(state[key], "base");
   assert.equal(state.parakeetModel, "parakeet-tdt-0.6b-v3");
   assert.deepEqual(notices.takeQueuedRetiredModelSwitches(), []);
 });
