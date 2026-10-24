const test = require("node:test");
const assert = require("node:assert/strict");
const { parseAuthStatus, createCliResolver } = require("../../../src/services/agents/cliResolver");

test("Claude auth JSON maps each documented method", () => {
  for (const method of [
    "none",
    "claude.ai",
    "oauth_token",
    "api_key",
    "api_key_helper",
    "third_party",
  ]) {
    assert.deepEqual(
      parseAuthStatus({
        exitCode: 0,
        stdout: JSON.stringify({ authMethod: method, configDirectory: "/tmp/claude" }),
      }),
      {
        state: "authenticated",
        method,
        detail: "/tmp/claude",
      }
    );
  }
});

test("Claude auth failures retain stable states without leaking secrets", () => {
  assert.deepEqual(parseAuthStatus({ exitCode: 1, stdout: '{"authMethod":"none"}' }), {
    state: "not_authenticated",
    method: "none",
    detail: null,
  });
  assert.equal(parseAuthStatus({ exitCode: 2, stdout: "" }).state, "unknown");
  assert.equal(parseAuthStatus({ exitCode: 0, stdout: "garbage" }).detail, "unparseable output");
  assert.equal(parseAuthStatus({ exitCode: 0, stdout: "" }).detail, "empty output");
  assert.equal(parseAuthStatus({ exitCode: "ETIMEDOUT" }).detail, "timeout");
  assert.equal(parseAuthStatus({ exitCode: "sk-secret" }).detail, "exit <REDACTED>");
  const parsed = parseAuthStatus({
    exitCode: 0,
    stdout: JSON.stringify({
      authMethod: "api_key",
      apiKey: "plainsecret",
      note: "Bearer abc123 sk-secret owk_secret",
    }),
  });
  assert.doesNotMatch(JSON.stringify(parsed), /abc123|sk-secret|owk_secret|plainsecret/);
});

test("Cursor status uses its documented read-only command", async () => {
  const calls = [];
  const resolver = createCliResolver({
    configuredPaths: { "cursor-agent": process.execPath },
    run: async (binary, args) => {
      calls.push({ binary, args });
      return { stdout: args[0] === "--version" ? "cursor 1" : "Login successful", stderr: "" };
    },
  });
  assert.equal((await resolver.authStatus("cursor-agent")).state, "authenticated");
  assert.deepEqual(calls.at(-1), { binary: process.execPath, args: ["status"] });
});

test("resolver runs Claude auth status on its absolute path without --json", async () => {
  const calls = [];
  const resolver = createCliResolver({
    configuredPaths: { claude: process.execPath },
    run: async (binary, args, options) => {
      calls.push({ binary, args, options });
      return {
        stdout: args[0] === "--version" ? "2.1.300" : '{"authMethod":"claude.ai"}',
        stderr: "",
      };
    },
  });
  assert.equal((await resolver.authStatus("claude")).state, "authenticated");
  assert.deepEqual(calls.at(-1).args, ["auth", "status"]);
  assert.equal(calls.at(-1).binary, process.execPath);
  assert.equal(calls.at(-1).options.timeout, 5000);
});

test("Cursor model probe accepts JSON or line lists and caches per process", async () => {
  for (const output of [
    '{"models":[{"id":"auto"},{"name":"gpt-5"}]}',
    "Available models:\n- auto\n- gpt-5 (recommended)",
  ]) {
    let probes = 0;
    const resolver = createCliResolver({
      configuredPaths: { "cursor-agent": process.execPath },
      run: async (_binary, args) => {
        if (args[0] === "--list-models") {
          probes++;
          return { stdout: output };
        }
        return { stdout: "cursor 1" };
      },
    });
    assert.deepEqual(await resolver.listModels("cursor-agent"), ["auto", "gpt-5"]);
    assert.deepEqual(await resolver.listModels("cursor-agent"), ["auto", "gpt-5"]);
    assert.equal(probes, 1);
  }
});
