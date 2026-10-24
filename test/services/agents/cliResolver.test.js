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
  assert.deepEqual(calls.at(-2).args, ["auth", "status"]);
  assert.deepEqual(calls.at(-1).args, ["auth", "status", "--text"]);
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
    const expected = output.startsWith("{") ? ["auto", "gpt-5"] : ["auto"];
    assert.deepEqual(await resolver.listModels("cursor-agent"), { ok: true, models: expected });
    assert.deepEqual(await resolver.listModels("cursor-agent"), { ok: true, models: expected });
    assert.equal(probes, 1);
  }
});

test("resolver diagnostics redact both Claude probes", async () => {
  const resolver = createCliResolver({
    configuredPaths: { claude: process.execPath },
    run: async (_binary, args) => {
      if (args[0] === "--version") return { stdout: "2.1.300 sk-secret", stderr: "Bearer abc123" };
      if (args.includes("--text"))
        return {
          stdout: "Login method: Claude Max\nEmail: owner@example.com sk-secret",
          stderr: "Bearer abc123",
        };
      return {
        stdout: JSON.stringify({
          authMethod: "claude.ai",
          configDirectory: "/tmp/config",
          apiKey: "sk-secret",
        }),
        stderr: "Bearer abc123",
      };
    },
  });
  const tested = await resolver.test("claude");
  assert.deepEqual(tested.argv, ["--version"]);
  assert.equal(tested.exitCode, 0);
  assert.doesNotMatch(tested.stdoutSnippet + tested.stderrSnippet, /sk-secret|abc123/);
  const auth = await resolver.authStatus("claude");
  assert.equal(auth.configDirectory, "/tmp/config");
  assert.equal(auth.authMethod, "claude.ai");
  assert.deepEqual(auth.argv, ["auth", "status"]);
  assert.deepEqual(auth.textProbe.argv, ["auth", "status", "--text"]);
  assert.doesNotMatch(
    auth.stdoutSnippet +
      auth.stderrSnippet +
      auth.textProbe.stdoutSnippet +
      auth.textProbe.stderrSnippet,
    /sk-secret|abc123|owner@example.com/
  );
  assert.ok(auth.durationMs >= 0);
});

test("Cursor model probe rejects prose, empty, failure and timeout without caching", async () => {
  for (const output of ["Loading\nLoading...\nNo models\nSign in to continue", ""]) {
    let calls = 0;
    const resolver = createCliResolver({
      configuredPaths: { "cursor-agent": process.execPath },
      run: async (_binary, args) => {
        if (args[0] === "--list-models") {
          calls++;
          return { stdout: output };
        }
        return { stdout: "cursor 1" };
      },
    });
    assert.equal((await resolver.listModels("cursor-agent")).ok, false);
    assert.equal((await resolver.listModels("cursor-agent")).ok, false);
    assert.equal(calls, 2);
  }
  for (const code of [2, "ETIMEDOUT"]) {
    const resolver = createCliResolver({
      configuredPaths: { "cursor-agent": process.execPath },
      run: async (_binary, args) => {
        if (args[0] === "--list-models") throw Object.assign(new Error("failed"), { code });
        return { stdout: "cursor 1" };
      },
    });
    assert.equal((await resolver.listModels("cursor-agent")).ok, false);
  }
  const mixed = createCliResolver({
    configuredPaths: { "cursor-agent": process.execPath },
    run: async (_binary, args) => ({
      stdout:
        args[0] === "--list-models"
          ? "Loading\n- grok-4.7\nNo models\n• gpt/5\nSign in to continue"
          : "cursor 1",
    }),
  });
  assert.deepEqual(await mixed.listModels("cursor-agent"), {
    ok: true,
    models: ["grok-4.7", "gpt/5"],
  });
});

test("probe snippets have byte limits and shared environment passes only allowed values", async () => {
  const { minimalEnv } = require("../../../src/services/agents/minimalEnv");
  const original = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    OPENWHISPR_UNRELATED_SECRET: process.env.OPENWHISPR_UNRELATED_SECRET,
  };
  try {
    process.env.ANTHROPIC_API_KEY = "user-provided";
    process.env.XDG_CONFIG_HOME = "/tmp/config";
    process.env.OPENWHISPR_UNRELATED_SECRET = "not-allowed";
    assert.equal(minimalEnv().ANTHROPIC_API_KEY, "user-provided");
    assert.equal(minimalEnv().XDG_CONFIG_HOME, "/tmp/config");
    assert.equal(minimalEnv().OPENWHISPR_UNRELATED_SECRET, undefined);
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(minimalEnv().ANTHROPIC_API_KEY, undefined);
    process.env.ANTHROPIC_API_KEY = "user-provided";
    const resolver = createCliResolver({
      configuredPaths: { claude: process.execPath },
      run: async () => ({ stdout: "é".repeat(2000), stderr: "é".repeat(500) }),
    });
    const result = await resolver.test("claude");
    assert.ok(Buffer.byteLength(result.stdoutSnippet) <= 2048);
    assert.ok(Buffer.byteLength(result.stderrSnippet) <= 500);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Claude JSON state stays authoritative when text probe disagrees", async () => {
  const resolver = createCliResolver({
    configuredPaths: { claude: process.execPath },
    run: async (_binary, args) => {
      if (args[0] === "--version") return { stdout: "2.1.300" };
      if (args.includes("--text"))
        return { stdout: "Login method: Claude Max account", stderr: "" };
      throw Object.assign(new Error("not signed in"), {
        code: 1,
        stdout: JSON.stringify({ authMethod: "none", configDirectory: "/tmp/claude" }),
        stderr: "not signed in",
      });
    },
  });
  const result = await resolver.authStatus("claude");
  assert.equal(result.state, "not_authenticated");
  assert.equal(result.configDirectory, "/tmp/claude");
  assert.equal(result.exitCode, 1);
  assert.equal(result.textProbe.exitCode, 0);
  assert.match(result.textProbe.stdoutSnippet, /Claude Max account/);
});

test("Cursor JSON model object accepts id and name fields", () => {
  const { modelIds } = require("../../../src/services/agents/cliResolver");
  assert.deepEqual(modelIds('{"id":"grok-4.7"}'), ["grok-4.7"]);
  assert.deepEqual(modelIds('{"name":"gpt/5"}'), ["gpt/5"]);
});
