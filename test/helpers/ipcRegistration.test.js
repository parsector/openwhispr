const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const vm = require("node:vm");
const createTempDir = require("../lib/tempDir");
const { withDevicePolicy } = require("./harness/devicePolicy");

// Electron rejects duplicate handle registrations; treat repeated on listeners
// just as strictly so event side effects cannot silently run twice either.
function strictIpcMain() {
  const channels = new Map();
  const register = (method) => (channel, handler) => {
    assert.equal(channels.has(channel), false, `Duplicate IPC channel: ${channel} (${method})`);
    channels.set(channel, { method, handler });
  };
  return { channels, handle: register("handle"), on: register("on") };
}

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

test("real main-process IPC initialization boots without duplicate channels; reinitialization fails", (t) => {
  const directory = createTempDir(path.join(os.tmpdir(), "ipc-registration-"));
  const ipcMain = strictIpcMain();
  const electron = {
    app: {
      getPath: () => directory,
      getName: () => "test",
      getVersion: () => "0.0.0",
      isPackaged: false,
      on: () => {},
      requestSingleInstanceLock: () => true,
    },
    ipcMain,
    BrowserWindow: class {
      static getAllWindows() {
        return [];
      }
      static fromWebContents() {
        return null;
      }
    },
    net: {
      fetch: () => {
        throw new Error("Startup test must not use the network");
      },
    },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
    systemPreferences: { getMediaAccessStatus: () => "granted" },
    session: { fromPartition: () => ({}) },
    shell: {},
    dialog: {},
    clipboard: {},
    nativeImage: {},
    globalShortcut: {},
    utilityProcess: {},
    MessageChannelMain: class {},
  };
  const originalLoad = Module._load;
  const filename = require.resolve("../../src/helpers/ipcHandlers");
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => {
    Module._load = originalLoad;
    delete require.cache[filename];
    fs.rmSync(directory, { recursive: true, force: true });
  });
  delete require.cache[filename];
  const IPCHandlers = require(filename);
  const databaseManager = new Proxy(
    {
      listRoutines: () => [],
      activeAccountId: null,
      db: {
        prepare: () => ({ run: () => ({ changes: 0 }), all: () => [] }),
        transaction: (fn) => fn,
      },
    },
    { get: (target, property) => (property in target ? target[property] : anything()) }
  );
  const context = withDevicePolicy(
    new Proxy(
      { sessionId: "registration-test", databaseManager },
      {
        get: (target, property) => (property in target ? target[property] : anything()),
      }
    )
  );
  t.after(() => {
    if (Object.hasOwn(context, "routineScheduler")) context.routineScheduler.stop();
  });
  // Run the actual registration methods called by the constructor, with only
  // unrelated managers stubbed. Imports and delegated registrars remain real.
  IPCHandlers.prototype.setupHandlers.call(context);
  IPCHandlers.prototype.setupRoutines.call(context);
  assert.ok(ipcMain.channels.size > 300);
  assert.equal(ipcMain.channels.get("db-upsert-note-from-cloud").method, "handle");
  assert.equal(ipcMain.channels.get("routines-recording").method, "on");
  assert.throws(() => IPCHandlers.prototype.setupHandlers.call(context), /Duplicate IPC channel:/);
  assert.throws(
    () => IPCHandlers.prototype.setupRoutines.call(context),
    /Duplicate IPC channel: routines-recording/
  );
});

test("duplicate guard rejects repeated listeners as well as handlers", () => {
  for (const method of ["handle", "on"]) {
    const ipc = strictIpcMain();
    ipc[method]("example", () => {});
    assert.throws(() => ipc[method]("example", () => {}), /Duplicate IPC channel: example/);
  }
});

test("preload forwards every sync argument to the kept main-process signatures", async () => {
  let api;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../preload.js"), "utf8"), {
    process,
    require: (specifier) => {
      assert.equal(specifier, "electron");
      return {
        contextBridge: {
          exposeInMainWorld: (_name, exposed) => {
            api = exposed;
          },
        },
        ipcRenderer: { invoke: (...args) => calls.push(args), on() {}, send() {}, sendSync() {} },
      };
    },
  });
  const cases = [
    [
      "upsertNoteFromCloud",
      "db-upsert-note-from-cloud",
      [{ id: "cloud" }, 12, 34, 56, { newKeyIfTaken: true }],
    ],
    ["markNoteCreatesAttempted", "db-mark-note-creates-attempted", [["client"], 56]],
    [
      "acknowledgeConversationCreate",
      "db-acknowledge-conversation-create",
      [1, { title: "chat" }, "cloud", "account", 56],
    ],
    [
      "markConversationSynced",
      "db-mark-conversation-synced",
      [1, "cloud", { title: "chat" }, 123, "account", 56],
    ],
  ];
  for (const [method, channel, args] of cases) {
    await api[method](...args);
    assert.deepEqual(calls.pop(), [channel, ...args]);
  }
});
