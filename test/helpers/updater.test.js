const test = require("node:test");
const { afterEach, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.NODE_ENV = "test";

const updaterModulePath = require.resolve("../../src/updater.js");
const originalLoad = Module._load;
const originalPlatform = process.platform;
const originalAppImage = process.env.APPIMAGE;
let userData;
let packaged = true;


function makeAutoUpdater({ offline = false } = {}) {
  const listeners = {};
  const autoUpdater = {
    calls: 0,
    downloads: 0,
    listeners,
    setFeedURL() {},
    on(event, handler) {
      listeners[event] = handler;
    },
    removeListener() {},
    checkForUpdates() {
      autoUpdater.calls += 1;
      if (offline) {
        // electron-updater emits the error before rejecting
        const error = new Error("net::ERR_INTERNET_DISCONNECTED");
        listeners.error?.(error);
        return Promise.reject(error);
      }
      return Promise.resolve({ isUpdateAvailable: false });
    },
    downloadUpdate() {
      autoUpdater.downloads += 1;
      return Promise.resolve();
    },
  };
  return autoUpdater;
}

// updater.js requires electron and child_process lazily (constructor, cleanup(),
// Rosetta probe), so the mocks stay installed until afterEach.
function createUpdateManager(autoUpdater) {
  delete require.cache[updaterModulePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron-updater") return { autoUpdater };
    if (request === "electron") return {
      app: { getPath: () => userData, get isPackaged() { return packaged; } },
      autoUpdater: { on() {}, removeListener() {} },
    };
    if (request === "child_process") return { execSync: () => "0" };
    return originalLoad.call(this, request, parent, isMain);
  };
  const UpdateManager = require(updaterModulePath);
  return new UpdateManager();
}

function setPlatform(platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

beforeEach((t) => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-updater-"));
  packaged = true;
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  // The updater is unsupported on Linux outside an AppImage, so a test that
  // does not pick a platform would never check for updates on a Linux CI runner.
  setPlatform("darwin");
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
  Module._load = originalLoad;
  setPlatform(originalPlatform);
  if (originalAppImage === undefined) delete process.env.APPIMAGE;
  else process.env.APPIMAGE = originalAppImage;
});

test("packaged startup schedules a check; manual checks remain available", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);
  assert.equal(autoUpdater.calls, 0);
  assert.equal(manager.checkTimer !== null, true);
  await manager.checkForUpdates();
  assert.equal(autoUpdater.calls, 1);
  manager.cleanup();
});

test("a persisted disabled preference prevents automatic download", () => {
  require("../../src/helpers/updatePreferences").writeAutoUpdatesEnabled(userData, false);
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);

  autoUpdater.listeners["update-available"]({ version: "9.9.9" });
  assert.equal(autoUpdater.downloads, 0);

  manager.cleanup();
});

test("with automatic updates on, an available update downloads itself exactly once", () => {
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);
  manager.setAutoUpdatesEnabled(true);

  autoUpdater.listeners["update-available"]({ version: "9.9.9" });
  assert.equal(autoUpdater.downloads, 1);

  // A periodic re-check while the download is in flight must not start another.
  autoUpdater.listeners["update-available"]({ version: "9.9.9" });
  assert.equal(autoUpdater.downloads, 1);

  autoUpdater.listeners["update-downloaded"]({ version: "9.9.9" });
  autoUpdater.listeners["update-available"]({ version: "9.9.9" });
  assert.equal(autoUpdater.downloads, 1, "a downloaded update is never fetched again");

  manager.cleanup();
});

test("with automatic updates off, an available update waits for the user", () => {
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);
  manager.setAutoUpdatesEnabled(false);

  autoUpdater.listeners["update-available"]({ version: "9.9.9" });
  assert.equal(autoUpdater.downloads, 0);

  manager.cleanup();
});

test("deferInstallOnQuit clears the flag the NSIS and AppImage quit handlers read", () => {
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);
  assert.equal(autoUpdater.autoInstallOnAppQuit, true);

  manager.deferInstallOnQuit();
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);

  manager.cleanup();
});

test("only a macOS update that Squirrel already holds counts as staged", () => {
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);
  assert.equal(manager.hasStagedUpdate(), false);

  autoUpdater.squirrelDownloadedUpdate = true;
  assert.equal(manager.hasStagedUpdate(), true);

  setPlatform("win32");
  assert.equal(manager.hasStagedUpdate(), false);

  manager.cleanup();
});

test("enabling automatic updates after a manual check found one starts the download", () => {
  require("../../src/helpers/updatePreferences").writeAutoUpdatesEnabled(userData, false);
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);

  autoUpdater.listeners["update-available"]({ version: "9.9.9" });
  assert.equal(autoUpdater.downloads, 0, "disabled preference prevents download");

  manager.setAutoUpdatesEnabled(true);
  assert.equal(autoUpdater.downloads, 1);

  manager.setAutoUpdatesEnabled(true);
  assert.equal(autoUpdater.downloads, 1, "re-syncing the preference does not restart it");

  manager.cleanup();
});

test("on macOS and Windows the updater reports itself as supported", async () => {
  for (const platform of ["darwin", "win32"]) {
    setPlatform(platform);
    const manager = createUpdateManager(makeAutoUpdater());
    assert.equal((await manager.getUpdateStatus()).isSupported, true, platform);
    manager.cleanup();
  }
});

test("a Linux AppImage is supported, but deb/rpm/tar.gz installs never touch the feed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  setPlatform("linux");

  process.env.APPIMAGE = "/opt/OpenWhispr.AppImage";
  const appImage = createUpdateManager(makeAutoUpdater());
  assert.equal((await appImage.getUpdateStatus()).isSupported, true);
  appImage.cleanup();

  delete process.env.APPIMAGE;
  const autoUpdater = makeAutoUpdater();
  const packaged = createUpdateManager(autoUpdater);
  packaged.setAutoUpdatesEnabled(true);
  assert.equal((await packaged.getUpdateStatus()).isSupported, false);

  assert.equal(autoUpdater.calls, 0, "no automatic checks are scheduled");

  const result = await packaged.checkForUpdates();
  assert.equal(autoUpdater.calls, 0, "a manual check short-circuits too");
  assert.equal(result.updateAvailable, false);
  assert.match(result.message, /package manager/);

  packaged.cleanup();
});

test("startup and periodic checks use 30 seconds and six hours", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const updater = makeAutoUpdater();
  const manager = createUpdateManager(updater);
  t.mock.timers.tick(29_999);
  assert.equal(updater.calls, 0);
  t.mock.timers.tick(1);
  assert.equal(updater.calls, 1);
  await new Promise(setImmediate);
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  assert.equal(updater.calls, 2);
  manager.cleanup();
});

test("disabled at startup or on a tick performs no check", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { writeAutoUpdatesEnabled } = require("../../src/helpers/updatePreferences");
  writeAutoUpdatesEnabled(userData, false);
  const updater = makeAutoUpdater();
  const manager = createUpdateManager(updater);
  t.mock.timers.tick(7 * 60 * 60 * 1000);
  assert.equal(updater.calls, 0);
  manager.setAutoUpdatesEnabled(true);
  manager.setAutoUpdatesEnabled(false);
  t.mock.timers.tick(7 * 60 * 60 * 1000);
  assert.equal(updater.calls, 0);
  manager.cleanup();
});

test("enabling schedules promptly and disabling cancels the startup timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const updater = makeAutoUpdater();
  const manager = createUpdateManager(updater);
  manager.setAutoUpdatesEnabled(false);
  t.mock.timers.tick(30_000);
  assert.equal(updater.calls, 0);
  manager.setAutoUpdatesEnabled(true);
  t.mock.timers.tick(2_999);
  assert.equal(updater.calls, 0);
  t.mock.timers.tick(1);
  assert.equal(updater.calls, 1);
  manager.cleanup();
});

test("in-flight checks are skipped, not queued", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  const updater = makeAutoUpdater();
  updater.checkForUpdates = () => { updater.calls++; return new Promise((resolve) => { finish = resolve; }); };
  const manager = createUpdateManager(updater);
  t.mock.timers.tick(30_000);
  assert.equal(updater.calls, 1);
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  assert.equal(updater.calls, 1);
  finish({ isUpdateAvailable: false });
  await Promise.resolve();
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  assert.equal(updater.calls, 2);
  finish({ isUpdateAvailable: false });
  manager.cleanup();
});

test("rejected background checks are silent and leave the cadence intact", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const updater = makeAutoUpdater({ offline: true });
  const manager = createUpdateManager(updater);
  const warn = t.mock.method(console, "warn", () => {});
  const notify = t.mock.method(manager, "notifyRenderers", () => {});
  t.mock.timers.tick(30_000);
  assert.equal(updater.calls, 1);
  await new Promise(setImmediate);
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(notify.mock.callCount(), 0);
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  assert.equal(updater.calls, 2);
  await new Promise(setImmediate);
  assert.equal(warn.mock.callCount(), 2);
  manager.cleanup();
});

test("cleanup cancels pending checks and unpackaged or dev builds never schedule", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const updater = makeAutoUpdater();
  const manager = createUpdateManager(updater);
  manager.cleanup();
  t.mock.timers.tick(7 * 60 * 60 * 1000);
  assert.equal(updater.calls, 0);

  packaged = false;
  const unpackaged = createUpdateManager(updater);
  assert.equal(unpackaged.checkTimer, null);
  unpackaged.cleanup();

  packaged = true;
  process.env.NODE_ENV = "development";
  const development = createUpdateManager(updater);
  assert.equal(development.checkTimer, null);
  development.cleanup();
  process.env.NODE_ENV = "test";
});

test("stored preference round-trips and absent file uses the renderer's fresh-install default", () => {
  const preferences = require("../../src/helpers/updatePreferences");
  assert.equal(preferences.DEFAULT_ENABLED, true);
  assert.equal(preferences.readAutoUpdatesEnabled(userData), true);
  const manager = createUpdateManager(makeAutoUpdater());
  manager.setAutoUpdatesEnabled(false);
  assert.equal(preferences.readAutoUpdatesEnabled(userData), false);
  manager.cleanup();
  const restarted = createUpdateManager(makeAutoUpdater());
  assert.equal(restarted.autoUpdatesEnabled, false);
  restarted.cleanup();
});

test("an automatic download is visible to main status and a manual click returns in-progress", async () => {
  const updater = makeAutoUpdater();
  let finish;
  updater.downloadUpdate = () => {
    updater.downloads++;
    return new Promise((resolve) => { finish = resolve; });
  };
  const manager = createUpdateManager(updater);
  updater.listeners["update-available"]({ version: "1.10.6", files: [{ url: "OpenWhispr-1.10.6-arm64-mac.zip" }] });
  assert.equal(updater.downloads, 1);
  assert.equal((await manager.getUpdateStatus()).isDownloading, true);
  assert.equal((await manager.downloadUpdate()).status, "in-progress");
  assert.equal(updater.downloads, 1);
  finish([]);
  await new Promise(setImmediate);
  manager.cleanup();
});

test("native Squirrel error after ZIP hand-off clears downloaded state and records the stack", async () => {
  const updater = makeAutoUpdater();
  updater.downloadUpdate = () => {
    updater.listeners["update-downloaded"]({ version: "1.10.6" });
    const error = new Error("SQRLCodeSignatureErrorDomain: code signature did not pass validation");
    updater.listeners.error(error);
    return Promise.reject(error);
  };
  const manager = createUpdateManager(updater);
  await assert.rejects(manager.downloadUpdate(), /code signature did not pass validation/);
  const status = await manager.getUpdateStatus();
  assert.equal(status.isDownloading, false);
  assert.equal(status.updateDownloaded, false);
  assert.match(fs.readFileSync(status.logPath, "utf8"), /SQRLCodeSignatureErrorDomain/);
  assert.match(fs.readFileSync(status.logPath, "utf8"), /at updater\.downloadUpdate/);
  manager.cleanup();
});

test("updater log strips URL queries and credentials", () => {
  const { createUpdaterLog } = require("../../src/helpers/updaterLog");
  const log = createUpdaterLog(userData);
  log.write("ERROR", "https://example.com/file.zip?token=secret Authorization: Bearer very-secret");
  const contents = fs.readFileSync(log.file, "utf8");
  assert.match(contents, /https:\/\/example.com\/file.zip/);
  assert.doesNotMatch(contents, /very-secret|token=secret/);
});

test("updater log rotates at one MiB", () => {
  const { createUpdaterLog } = require("../../src/helpers/updaterLog");
  const log = createUpdaterLog(userData);
  log.write("INFO", "x".repeat(1024 * 1024));
  log.write("INFO", "next entry");
  assert.equal(fs.existsSync(`${log.file}.1`), true);
  assert.ok(fs.statSync(log.file).size < 1024 * 1024);
  assert.ok(fs.statSync(`${log.file}.1`).size <= 1024 * 1024);
});
