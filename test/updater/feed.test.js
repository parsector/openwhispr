const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.resolve(__dirname, "../..");

test("runtime updater uses the fork GitHub feed", () => {
  const updaterPath = path.join(root, "src/updater.js");
  const originalLoad = Module._load;
  const originalNodeEnv = process.env.NODE_ENV;
  const nativeUpdater = { on() {}, removeListener() {} };
  let feed;

  try {
    process.env.NODE_ENV = "test";
    delete require.cache[require.resolve(updaterPath)];
    Module._load = function loadWithUpdaterMock(request, parent, isMain) {
      if (request === "electron-updater") {
        return {
          autoUpdater: {
            setFeedURL(config) { feed = config; },
            on() {},
            removeListener() {},
          },
        };
      }
      if (request === "electron") return { autoUpdater: nativeUpdater };
      return originalLoad.call(this, request, parent, isMain);
    };

    const UpdateManager = require(updaterPath);
    const manager = new UpdateManager();
    manager.cleanup();
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(updaterPath)];
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }

  assert.equal(feed.provider, "github");
  assert.equal(feed.owner, "parsector");
  assert.equal(feed.repo, "openwhispr");
});

test("electron-builder publishes to the same fork feed", () => {
  const { publish } = require(path.join(root, "electron-builder.json"));
  assert.equal(publish.provider, "github");
  assert.equal(publish.owner, "parsector");
  assert.equal(publish.repo, "openwhispr");
});

test("main-process files have no vendor update feed", () => {
  const mainProcessPaths = ["main.js", "preload.js", "src/updater.js", "src/helpers", "src/services", "src/workers"];

  function check(file) {
    if (fs.statSync(file).isDirectory()) {
      for (const entry of fs.readdirSync(file)) check(path.join(file, entry));
      return;
    }
    if (!/\.(?:cjs|js|mjs)$/.test(file)) return;
    const source = fs.readFileSync(file, "utf8");
    const feeds = source.match(/setFeedURL\s*\(\s*\{[^}]*\}/g) || [];
    for (const feed of feeds) {
      assert.doesNotMatch(feed, /owner\s*:\s*["']OpenWhispr["']/, file);
    }
    assert.doesNotMatch(source, /github\.com\/OpenWhispr\/openwhispr\/releases\//i, file);
  }

  for (const entry of mainProcessPaths) check(path.join(root, entry));
});
