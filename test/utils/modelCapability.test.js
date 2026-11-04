const test = require("node:test");
const assert = require("node:assert/strict");

const {
  estimateModelSizeB,
  modelSupportsToolCalls,
  endpointSupportsToolCalls,
  routineEndpointSupportsTools,
} = require("../../src/utils/modelCapability.ts");

const cases = [
  ["gpt-oss:120b-cloud", 120, true],
  ["deepseek-v3.1:671b-cloud", 671, true],
  ["qwen3-coder:480b-cloud", 480, true],
  ["qwen3-coder:32b-cloud", 32, true],
  ["gemma3:27b", 27, true],
  ["mistral-nemo:12b", 12, true],
  ["llama3.1:8b", 8, true],
  ["qwen2.5-7b-instruct", 7, true],
  ["gpt-oss-120b", 120, true],
  ["foo-bar", null, true],
  ["", null, true],
  ["ollama/llama3.1:8b", 8, true],
  ["gemma3:4b", 4, true],
  ["some-1.5b-model", 1.5, false],
  ["gemma3:3b", 3, false],
];

for (const [modelId, sizeB, supportsTools] of cases) {
  test(`tool capability for ${JSON.stringify(modelId)}`, () => {
    assert.equal(estimateModelSizeB(modelId), sizeB);
    assert.equal(modelSupportsToolCalls(modelId), supportsTools);
  });
}

test("cloud suffix overrides the local size floor", () => {
  assert.equal(estimateModelSizeB("gemma3:3b-cloud"), 3);
  assert.equal(modelSupportsToolCalls("gemma3:3b-cloud"), true);
});

test("size syntax is case insensitive", () => {
  assert.equal(estimateModelSizeB("model:71.5B"), 71.5);
  assert.equal(estimateModelSizeB("model-4B"), 4);
});

test("a user endpoint trusts the owner's model capability setting", () => {
  const endpoint = {
    mode: "self-hosted",
    provider: "lan",
    remoteUrl: "https://inference.aimaterialhub.com/v1",
    model: "deepseek-v4.1-flash:1017-cloud",
  };
  assert.equal(estimateModelSizeB(endpoint.model), null);
  assert.equal(endpointSupportsToolCalls(endpoint), true);
  assert.equal(routineEndpointSupportsTools(endpoint), true);
  assert.equal(endpointSupportsToolCalls({ ...endpoint, supportsToolCalls: false }), false);
  assert.equal(routineEndpointSupportsTools({ ...endpoint, supportsToolCalls: false }), false);
  assert.equal(endpointSupportsToolCalls({ ...endpoint, mode: "enterprise" }), true);
});

test("the same id on the managed local lineup keeps its known-size requirement", () => {
  const local = { mode: "local", provider: "ollama", model: "deepseek-v4.1-flash:1017-cloud" };
  assert.equal(endpointSupportsToolCalls(local), false);
  assert.equal(routineEndpointSupportsTools(local), false);
  assert.equal(endpointSupportsToolCalls({ ...local, model: "gemma3:3b" }), false);
  assert.equal(endpointSupportsToolCalls({ ...local, model: "llama3.1:8b" }), true);
});
