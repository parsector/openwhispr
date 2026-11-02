const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWorkspacePolicyManager } = require("../../src/helpers/workspacePolicyManager");
const { createAudioFeaturePolicy } = require("../../src/helpers/audioFeaturePolicy");

function setupPolicy(fetchPolicy, token = "personal-token") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "personal-audio-policy-"));
  const tokenState = { token, generation: 1 };
  const manager = createWorkspacePolicyManager({
    cachePath: path.join(directory, "policy.json"),
    getApiUrl: () => "https://api.openwhispr.test",
    getAppVersion: () => "1.12.1",
    proxyFetch: fetchPolicy,
    tokenStore: { getState: () => tokenState },
    requestTimeoutMs: 20,
    minimumAttemptIntervalMs: 0,
    successfulRefreshMs: 0,
  });
  const request = { accountId: "personal", expectedAuthGeneration: 1 };
  const guard = createAudioFeaturePolicy({
    getPolicy: () => manager.getPolicy(request),
    lookupDeadlineMs: 25,
  });
  return {
    manager,
    request,
    guard,
    tokenState,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

for (const [name, token, fetchPolicy] of [
  [
    "signed-out personal",
    null,
    async () => {
      throw new Error("must not fetch");
    },
  ],
  [
    "offline personal",
    "personal-token",
    async () => {
      throw new Error("offline");
    },
  ],
])
  for (const purpose of ["meeting", "upload"]) {
    test(`${name} can start ${purpose}`, async (t) => {
      const { guard, cleanup } = setupPolicy(fetchPolicy, token);
      t.after(cleanup);
      let started = false;
      const result = await guard.run({}, purpose, () => {
        started = true;
        return { success: true };
      });
      assert.equal(started, true, purpose);
      assert.deepEqual(result, { success: true });
    });
  }

test("renderer allows personal meeting, notification join, and upload during an offline lookup", async () => {
  const { isAudioFeatureAllowed, isTranscriptionContextAllowed } =
    await import("../../src/stores/policyRules.ts");
  const state = { status: "error", managed: false, policy: null, appVersion: "1.12.1" };
  const settings = { meetingTranscriptionMode: "local", uploadTranscriptionMode: "local" };
  for (const purpose of ["meeting", "upload"]) {
    assert.equal(isAudioFeatureAllowed(state, purpose), true, purpose);
    assert.equal(isTranscriptionContextAllowed(state, settings, purpose), true, purpose);
  }
});

test("managed disabled meeting and upload controls retain their organization refusals offline", async (t) => {
  let offline = false;
  const { guard, cleanup } = setupPolicy(async () => {
    if (offline) throw new Error("offline");
    return new Response(
      JSON.stringify({
        data: {
          managed: true,
          policyUpdatedAt: "2026-11-01T00:00:00.000Z",
          policy: {
            version: 1,
            transcription: { allowedModes: ["local"], allowedByokProviders: [] },
            llm: {
              allowedModes: ["local"],
              allowedByokProviders: [],
              allowedEnterpriseProviders: [],
            },
            features: {
              agentEnabled: false,
              webSearchEnabled: false,
              meetingRecordingEnabled: false,
              audioUploadEnabled: false,
            },
            sharing: { externalLinkSharing: "disabled" },
            dataRetention: {
              audioRetentionMaxDays: null,
              localHistoryMode: "user_choice",
              cloudBackupAllowed: false,
            },
            minAppVersion: null,
          },
        },
      }),
      { status: 200 }
    );
  });
  t.after(cleanup);
  assert.equal(
    (await guard.run({}, "meeting", () => ({ success: true }))).code,
    "POLICY_MEETING_RECORDING_DISABLED"
  );
  offline = true;
  const upload = await guard.run({}, "upload", () => ({ success: true }));
  assert.equal(upload.code, "POLICY_AUDIO_UPLOAD_DISABLED");
  assert.match(upload.error, /organization/);
});

test("explicit managed policy failure refuses recording with a retryable reason", async (t) => {
  const { guard, cleanup } = setupPolicy(
    async () =>
      new Response(
        JSON.stringify({ code: "POLICY_UNRESOLVABLE", error: "Managed policy is unavailable" }),
        { status: 503 }
      )
  );
  t.after(cleanup);
  const result = await guard.run({}, "meeting", () => ({ success: true }));
  assert.equal(result.code, "POLICY_UNRESOLVABLE");
  assert.match(result.error, /organization.*policy.*(?:load|verif)/i);
  assert.match(result.error, /retry/i);
});
