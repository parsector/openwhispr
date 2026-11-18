const test = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../../src/stores/policyRules.ts");
const { resolveEffectivePolicy } = require("../../src/helpers/effectivePolicyManager");
const { createManagedMeetingPolicy } = require("../../src/helpers/managedMeetingPolicy");
const { audioFeatureFailure } = require("../../src/helpers/audioFeaturePolicy");
const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
const { endpointSupportsToolCalls } = require("../../src/utils/modelCapability.ts");

for (const status of ["idle", "loading", "error", "unmanaged"]) {
  test(`unmanaged ${status} allows local policy gates without a policy document`, () => {
    const state = { status, managed: false, policy: null, appVersion: null };
    assert.equal(rules.isPolicyActionAllowed(state), true);
    assert.equal(rules.isAgentAllowed(state), true);
    assert.equal(rules.isAudioFeatureAllowed(state, "meeting"), true);
    assert.equal(rules.isAudioFeatureAllowed(state, "upload"), true);
    assert.equal(rules.isMeetingAutoTranscriptionAllowed(state, true), true);
    assert.equal(rules.isMeetingTranscriptionStartManual(state), false);
    assert.equal(rules.isLocalModelAllowedByPolicy(state, "llm", "owner-model"), true);
    assert.equal(rules.isLocalModelAllowedByPolicy(state, "transcription", ""), true);
    assert.equal(rules.isModeAllowedByPolicy(state, "llm", "self-hosted"), true);
    assert.equal(audioFeatureFailure({ ...state, success: false, code: "POLICY_UNRESOLVABLE" }, "meeting"), null);
    assert.equal(createManagedMeetingPolicy({ getSnapshot: () => state }).isMeetingRecordingDisabled(), false);
  });
}

test("a refusal code without management evidence does not create a managed installation", () => {
  const scope = { accountId: "personal", authGeneration: 1, authenticated: true };
  for (const deviceStatus of ["loading", "absent"]) {
    const verdict = resolveEffectivePolicy(
      { status: deviceStatus, managed: false, policy: null },
      { success: false, managed: false, code: "POLICY_UNRESOLVABLE" },
      scope
    );
    assert.equal(verdict.success, true);
    assert.equal(verdict.status, "unmanaged");
    assert.equal(verdict.managed, false);
    assert.equal(verdict.code, undefined);
  }
});

test("main-process local authorization permits unresolved unmanaged policy", async () => {
  const gate = createLocalModelPolicyGate({
    getPolicy: async () => ({ success: false, managed: false, code: "POLICY_UNRESOLVABLE" }),
    getHeldPolicy: () => null,
    getIdentity: () => 1,
    getAppVersion: () => "1.13.5",
  });
  await gate.resolve();
  assert.equal(gate.failure("transcription", "base"), null);
  assert.equal(gate.failure("transcription", ""), null);
});

test("unknown custom models and typed URLs retain tool support", () => {
  for (const mode of ["self-hosted", "providers", "enterprise", "local", "future-provider"]) {
    assert.equal(endpointSupportsToolCalls({
      mode,
      provider: "owner-provider",
      model: "owner-model",
      remoteUrl: "http://127.0.0.1:8080/v1",
      cloudBaseUrl: "https://owner.example/v1",
    }), true);
  }
});
