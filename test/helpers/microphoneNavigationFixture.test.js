const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createMicrophoneCaptureOwner } = require("../../src/helpers/microphoneCaptureOwner");

// Execute the real fixture with a controlled Electron timeline, without loading
// Electron. In the unsafe timeline admission opens while the old track is live,
// then the track ends before loadURL resolves (the old fixture missed this).
async function runFixture(unsafe) {
  const ipcMain = new EventEmitter();
  const windows = [];
  const errors = [];
  const track = { readyState: "live" };
  let finish;
  const exited = new Promise((resolve) => {
    finish = resolve;
  });
  class BrowserWindow {
    constructor() {
      windows.push(this);
      this.webContents = new EventEmitter();
      this.webContents.isLoading = () => false;
      this.webContents.stop = () => {};
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.executeJavaScript = (script) => vm.runInContext(script, this.context);
      const location = {};
      Object.defineProperty(location, "href", {
        set: () => {
          this.webContents.emit("did-start-navigation");
        },
      });
      const claimMicrophone = () => {
        const event = { sender: this.webContents };
        ipcMain.emit("navigation-contender-acquire", event);
        return event.returnValue;
      };
      this.context = vm.createContext({
        navigator: {
          mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track] }) },
        },
        window: {
          claimMicrophone,
          open: () => {
            const observer = new BrowserWindow();
            observer.context.opener = this.context;
            return observer;
          },
        },
        location,
        setTimeout: (callback) => setImmediate(callback),
      });
    }
    async loadURL(url) {
      if (!url.endsWith("/replacement")) return;
      if (!unsafe) track.readyState = "ended";
      this.webContents.emit("did-navigate");
      await new Promise(setImmediate);
      track.readyState = "ended";
    }
    destroy() {}
    static getAllWindows() {
      return windows;
    }
  }
  const server = new EventEmitter();
  server.listen = () => process.nextTick(() => server.emit("listening"));
  server.address = () => ({ port: 1234 });
  server.close = () => {};
  const fixturePath = path.resolve(__dirname, "../browser/fixtures/microphoneNavigation.cjs");
  const context = vm.createContext({
    __dirname: path.dirname(fixturePath),
    console: { log() {}, error: (error) => errors.push(String(error)) },
    setTimeout: () => ({ unref() {} }),
    require: (name) => {
      if (name === "electron")
        return {
          app: { commandLine: { appendSwitch() {} }, whenReady: async () => {}, exit: finish },
          BrowserWindow,
          ipcMain,
        };
      if (name === "node:http") return { createServer: () => server };
      if (name.endsWith("microphoneCaptureOwner")) return { createMicrophoneCaptureOwner };
      return require(name);
    },
  });
  vm.runInContext(fs.readFileSync(fixturePath, "utf8"), context, { filename: fixturePath });
  return { status: await exited, errors };
}

test(
  "navigation fixture rejects admission before track teardown even when loadURL later ends it",
  { timeout: 5000 },
  async () => {
    const result = await runFixture(true);
    assert.equal(result.status, 1, "the fixture must reject the unsafe overlap");
    assert.match(result.errors.join("\n"), /old track must already be ended/);
  }
);

test("navigation fixture accepts track teardown before admission", { timeout: 5000 }, async () => {
  const result = await runFixture(false);
  assert.equal(result.status, 0, result.errors.join("\n"));
});
