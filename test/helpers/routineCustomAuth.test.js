const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const handlersPath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "routine-auth-"));
const requests = [];
const logs = [];
const notifications = [];
const handlers = new Map();
let responseStatus = 200;
let run;
const electron = {
  app: { getPath: () => directory, getVersion: () => "0.0.0", isReady: () => false },
  ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: () => {} },
  net: {
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return {
        ok: responseStatus === 200,
        status: responseStatus,
        json: async () => ({ choices: [{ message: { content: "A short note" } }] }),
      };
    },
  },
  Notification: class {
    constructor(value) {
      notifications.push(value);
    }
    on() {}
    show() {}
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  shell: {},
  systemPreferences: {},
  session: {},
};
const loadWithMocks = function load(request, parent, isMain) {
  if (request === "electron") return electron;
  if (parent?.filename === handlersPath && request === "./windowBroadcast")
    return { broadcastToWindows: () => {} };
  if (parent?.filename === handlersPath && request === "./debugLogger")
    return new Proxy(
      {},
      {
        get:
          () =>
          (...args) =>
            logs.push(args),
      }
    );
  if (parent?.filename === handlersPath && request === "./routines/routineQueue")
    return {
      RoutineQueue: class {
        constructor({ run: execute }) {
          run = execute;
        }
      },
    };
  if (parent?.filename === handlersPath && request === "./routines/routineScheduler")
    return {
      RoutineScheduler: class {
        start() {}
      },
    };
  return originalLoad.call(this, request, parent, isMain);
};
let IPCHandlers;
try {
  Module._load = loadWithMocks;
  IPCHandlers = require(handlersPath);
} finally {
  Module._load = originalLoad;
}

function database() {
  const updates = [];
  const notes = [];
  const routine = {
    id: "r1",
    name: "Brief",
    prompt: "Write a note",
    space_id: 1,
    allowed_tools: [],
    model_override: null,
  };
  return {
    updates,
    notes,
    getRoutine: () => routine,
    updateRoutineRun: (_id, value) => updates.push(value),
    _accountScopeCondition: () => ({ sql: "1=1", params: [] }),
    db: { prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) },
    getFolders: () => [{ id: 1, routine_id: routine.id }],
    saveNote: (title, content) => {
      const note = { id: notes.length + 1, title, content };
      notes.push(note);
      return { note };
    },
  };
}

function setup(key, routineKey = "") {
  requests.length = 0;
  logs.length = 0;
  notifications.length = 0;
  const db = database();
  const instance = Object.assign(Object.create(IPCHandlers.prototype), {
    databaseManager: db,
    environmentManager: {
      getChatAgentCustomKey: () => key,
      getRoutinesCustomKey: () => routineKey,
    },
    notifyVectorChanges: () => {},
    _asyncMirrorWrite: () => {},
    windowManager: {},
  });
  try {
    Module._load = loadWithMocks;
    instance.setupRoutines();
  } finally {
    Module._load = originalLoad;
  }
  const choice = {
    mode: "self-hosted",
    provider: "qwen",
    model: "qwen",
    remoteUrl: "https://models.example/v1",
    cloudBaseUrl: "",
    useChatEndpointKey: true,
    useRoutinesEndpointKey: false,
  };
  handlers.get("routines-model-choice")({}, choice);
  return { db, choice, execute: (model = choice) => run({ id: "run1", routineId: "r1", model }) };
}

test("self-hosted routine sends the chat endpoint Bearer header", async () => {
  const fakeKey = "fake-routine-key";
  const { execute } = setup(fakeKey);
  const result = await execute();
  assert.equal(result.status, "partial");
  assert.equal(requests[0].url, "https://models.example/v1/chat/completions");
  assert.match(requests[0].init.headers.Authorization, /^Bearer \S+$/);
  assert.equal(JSON.parse(requests[0].init.body).model, "qwen");
});

test("an explicit self-hosted endpoint wins over stale provider IDs", async () => {
  for (const provider of ["anthropic", "tinfoil"]) {
    const { choice, execute } = setup("fake-routine-key");
    choice.provider = provider;
    const result = await execute();
    assert.equal(result.status, "partial");
    assert.equal(requests[0].url, "https://models.example/v1/chat/completions");
    assert.match(requests[0].init.headers.Authorization, /^Bearer \S+$/);
  }
});

test("a routines endpoint override uses its own saved key", async () => {
  const { choice, execute } = setup("", "fake-routine-key");
  choice.mode = "providers";
  choice.provider = "custom";
  choice.cloudBaseUrl = choice.remoteUrl;
  choice.remoteUrl = "";
  choice.useChatEndpointKey = false;
  choice.useRoutinesEndpointKey = true;
  handlers.get("routines-model-choice")({}, choice);
  const result = await execute();
  assert.equal(result.status, "partial");
  assert.match(requests[0].init.headers.Authorization, /^Bearer \S+$/);
  assert.equal(requests[0].url, "https://models.example/v1/chat/completions");
});

test("401 never exposes the endpoint key in run data, notes, notifications, or logs", async () => {
  const fakeKey = "fake-routine-key";
  const { db, execute } = setup(fakeKey);
  responseStatus = 401;
  try {
    const result = await execute();
    assert.equal(result.status, "failed");
    assert.match(requests[0].init.headers.Authorization, /^Bearer \S+$/);
    assert.match(db.updates.at(-1).error, /401/);
    assert.equal(db.notes.length, 0);
    assert.equal(notifications.length, 0);
    assert.doesNotMatch(
      JSON.stringify({ result, updates: db.updates, notes: db.notes, notifications, logs }),
      /fake-routine-key/
    );
  } finally {
    responseStatus = 200;
  }
});

test("missing chat endpoint key fails before the request and names its setting", async () => {
  const { db, execute } = setup("");
  const result = await execute();
  assert.equal(result.status, "failed");
  assert.match(db.updates.at(-1).error, /Chat.*API key.*Settings/i);
  assert.equal(requests.length, 0);
});

test("a different routine endpoint cannot borrow the chat key", async () => {
  const { choice, execute } = setup("fake-routine-key");
  const result = await execute({ ...choice, remoteUrl: "https://other.example/v1" });
  assert.equal(result.status, "failed");
  assert.match(result.error, /Routines.*API key.*Settings/i);
  assert.equal(requests.length, 0);
});

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
