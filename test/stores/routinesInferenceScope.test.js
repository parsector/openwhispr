const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const {
  ENTERPRISE_INFERENCE_SCOPES,
  resolveManagedEnterpriseScope,
} = require("../../src/helpers/enterpriseManagedConfig.mjs");

test("routines is registered with the renderer and managed scopes", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "routines-scope-registry-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  const { INFERENCE_SCOPES } = await vite.ssrLoadModule("/config/inferenceScopes.ts");
  const { getLlmRequestTimeoutSeconds } = await vite.ssrLoadModule("/helpers/llmRequestTimeout.js");
  assert.ok(INFERENCE_SCOPES.routines);
  assert.equal(INFERENCE_SCOPES.routines.cloudPurpose, "assistant");
  assert.deepEqual(INFERENCE_SCOPES.routines.storeKeys, {
    mode: "routinesMode",
    provider: "routinesProvider",
    model: "routinesModel",
    cloudBaseUrl: "routinesCloudBaseUrl",
    remoteUrl: "routinesRemoteUrl",
    customApiKey: "routinesCustomApiKey",
  });
  assert.deepEqual(
    ENTERPRISE_INFERENCE_SCOPES.filter((scope) => scope !== "dictationAgentVision").sort(),
    Object.keys(INFERENCE_SCOPES)
      .filter((scope) => scope !== "dictationAgentVision")
      .sort()
  );
  assert.equal(getLlmRequestTimeoutSeconds({ scope: "routines" }), 600);
  for (const locale of fs.readdirSync(path.resolve(__dirname, "../../src/locales"))) {
    const file = path.resolve(__dirname, "../../src/locales", locale, "translation.json");
    if (!fs.existsSync(file)) continue;
    const messages = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(messages.settingsPage.llms.tabs.routines, `${locale} routines label`);
  }
});

test("custom chat endpoint resolves into a routine choice with or without its scope override", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      chatAgentMode: "self-hosted",
      chatAgentProvider: "custom",
      chatAgentModel: "chat-model",
      chatAgentRemoteUrl: "https://models.example/v1",
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "routines-custom-endpoint-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  const { useSettingsStore, selectResolvedLLMConfig, setResolvedLLMConfig } =
    await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { routineModelChoice } = await vite.ssrLoadModule(
    "/helpers/routines/routineModelChoice.ts"
  );
  const chat = selectResolvedLLMConfig(useSettingsStore.getState(), "chatIntelligence");
  const inherited = routineModelChoice(
    selectResolvedLLMConfig(useSettingsStore.getState(), "routines"),
    chat
  );
  assert.deepEqual(inherited, {
    mode: "self-hosted",
    provider: "custom",
    model: "chat-model",
    remoteUrl: "https://models.example/v1",
    cloudBaseUrl: "",
    useChatEndpointKey: true,
    useRoutinesEndpointKey: false,
  });
  setResolvedLLMConfig("routines", {
    mode: "self-hosted",
    provider: "custom",
    model: "pinned-model",
    remoteUrl: "https://models.example/v1",
  });
  const sameEndpoint = routineModelChoice(
    selectResolvedLLMConfig(useSettingsStore.getState(), "routines"),
    chat
  );
  assert.deepEqual(sameEndpoint, { ...inherited, model: "pinned-model" });
  setResolvedLLMConfig("routines", {
    mode: "self-hosted",
    provider: "custom",
    model: "routine-model",
    remoteUrl: "https://models.example/other/v1",
  });
  const pinned = routineModelChoice(
    selectResolvedLLMConfig(useSettingsStore.getState(), "routines"),
    chat
  );
  assert.deepEqual(pinned, {
    mode: "self-hosted",
    provider: "custom",
    model: "routine-model",
    remoteUrl: "https://models.example/other/v1",
    cloudBaseUrl: "",
    useChatEndpointKey: false,
    useRoutinesEndpointKey: false,
  });
  assert.equal(globalThis.localStorage.getItem("routinesModel"), "routine-model");
});

test("Providers Custom keeps its base URL and selected model in the main routine choice", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      chatAgentMode: "providers",
      chatAgentProvider: "custom",
      chatAgentModel: "private-model",
      chatAgentCloudBaseUrl: "https://custom.example/api/v1?compat=chat",
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "routines-providers-custom-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  const { useSettingsStore, selectResolvedLLMConfig, setResolvedLLMConfig } =
    await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { routineModelChoice } = await vite.ssrLoadModule(
    "/helpers/routines/routineModelChoice.ts"
  );
  const state = useSettingsStore.getState();
  assert.deepEqual(
    routineModelChoice(
      selectResolvedLLMConfig(state, "routines"),
      selectResolvedLLMConfig(state, "chatIntelligence")
    ),
    {
      mode: "providers",
      provider: "custom",
      model: "private-model",
      remoteUrl: "",
      cloudBaseUrl: "https://custom.example/api/v1?compat=chat",
      useChatEndpointKey: true,
      useRoutinesEndpointKey: false,
    }
  );
  setResolvedLLMConfig("routines", {
    mode: "providers",
    provider: "custom",
    model: "pinned-model",
    cloudBaseUrl: "https://own.example/api/v1",
  });
  useSettingsStore.setState({ routinesCustomApiKey: "test-key" });
  const pinned = routineModelChoice(
    selectResolvedLLMConfig(useSettingsStore.getState(), "routines"),
    selectResolvedLLMConfig(useSettingsStore.getState(), "chatIntelligence"),
    true
  );
  assert.deepEqual(pinned, {
    mode: "providers",
    provider: "custom",
    model: "pinned-model",
    remoteUrl: "",
    cloudBaseUrl: "https://own.example/api/v1",
    useChatEndpointKey: false,
    useRoutinesEndpointKey: true,
  });
  assert.equal(
    globalThis.localStorage.getItem("routinesCloudBaseUrl"),
    "https://own.example/api/v1"
  );
  assert.equal(globalThis.localStorage.getItem("routinesCustomApiKey"), null);
});

test("unknown scope without managed configuration does not become an enterprise error", () => {
  assert.deepEqual(resolveManagedEnterpriseScope(null, "unknown"), { kind: "manual" });
  const rejected = resolveManagedEnterpriseScope({ providers: [{}] }, "unknown");
  assert.equal(rejected.code, "MANAGED_SCOPE_INVALID");
  assert.match(rejected.message, /scope is invalid/);
});
