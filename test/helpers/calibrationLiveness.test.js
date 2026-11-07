const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, measure } = require("../lib/calibrationLivenessFixture");

test("calibration delivers progress and services the main event loop during evidence collection", async () => {
  const f = await fixture(2216);
  try {
    const result = await measure(f);
    console.log(JSON.stringify(result));
    assert.ok(result.progressEvents > 1, "calibration must publish progress before completing");
    assert.ok(result.progressTicks > 2, "progress must move while the job is running");
    assert.ok(
      result.executionThreadId > 0,
      "the calibration engine must execute outside the main thread"
    );
    // Wall-clock heartbeat lag also includes host scheduling. Bound actual
    // main-thread CPU here; the standalone benchmark records the wall lag too.
    assert.ok(
      result.maxMainThreadCpuSliceMs < 50,
      `main thread ran for ${result.maxMainThreadCpuSliceMs} ms without yielding`
    );
    assert.ok(
      result.provenanceReads <= 34 * 4,
      "provenance must be resolved per note, never per row/approval pair"
    );
    assert.equal(result.state, "complete");
  } finally {
    f.close();
  }
});

test("active calibration cancels promptly and restarts without changing library evidence", async () => {
  const f = await fixture(340);
  try {
    const changes = () => f.database.db.prepare("SELECT total_changes() AS n").get().n;
    const before = changes();
    const cancelled = await measure(f, { count: 340, cancel: true, cancelAfterRows: 10 });
    assert.equal(cancelled.state, "cancelled");
    assert.ok(cancelled.processedRows >= 10 && cancelled.processedRows < 306);
    assert.ok(cancelled.cancelLatencyMs < 250, JSON.stringify(cancelled));
    assert.equal(changes(), before, "cancelling must not mutate any library table");
    const restarted = await measure(f, { count: 340 });
    assert.equal(restarted.state, "complete");
    assert.equal(changes(), before);
    assert.ok(restarted.decodes <= 34, "shared chunks must not be decoded once per row");
    const fs = require("node:fs");
    assert.deepEqual(fs.readdirSync(`${f.store.root}.calibration-jobs`), []);
    const orphan = require("node:path").join(`${f.store.root}.calibration-jobs`, "run-interrupted");
    fs.mkdirSync(orphan);
    fs.writeFileSync(require("node:path").join(orphan, "snapshot.db"), "disposable snapshot");
    await require("../../src/helpers/calibrationWorkerClient").recover(f.store);
    assert.equal(fs.existsSync(orphan), false, "next launch must remove interrupted snapshots");
    assert.equal(changes(), before);
  } finally {
    f.close();
  }
});

test("a worker exit without completion fails the job and permits a fresh run", async () => {
  const f = await fixture(340);
  try {
    const { Worker } = require("node:worker_threads");
    class ExitingWorker extends Worker {
      constructor(...args) {
        super(...args);
        this.once("online", () => void this.terminate());
      }
    }
    const job = { state: "running", progress: {} };
    await assert.rejects(
      require("../../src/helpers/calibrationWorkerClient").run(
        job,
        f.database,
        f.store,
        { kind: "all" },
        { notes: 34, rows: 340 },
        f.model,
        { WorkerClass: ExitingWorker }
      ),
      /exited before completion/
    );
    assert.equal(job.state, "failed");
    assert.deepEqual(require("node:fs").readdirSync(`${f.store.root}.calibration-jobs`), []);
    assert.equal((await measure(f, { count: 340 })).state, "complete");
  } finally {
    f.close();
  }
});

test("decoded chunks survive cache eviction without another decode or plaintext spill", async () => {
  const f = await fixture(340);
  const session = require("../../src/helpers/calibrationAudioSession").createSession(
    f.store,
    f.directory,
    { cacheBytes: 32 }
  );
  try {
    const note = f.database.db.prepare("SELECT id FROM notes ORDER BY id LIMIT 1").get();
    const first = await session.spanAsync(note.id, "mic", 0, 2, {});
    await session.spanAsync(note.id, "mic", 5, 7, {});
    const again = await session.spanAsync(note.id, "mic", 0, 2, {});
    assert.deepEqual(again.wav, first.wav);
    assert.equal(
      session.metrics.decodes,
      1,
      "identical source chunks are decoded once even after spilling"
    );
    const fs = require("node:fs"),
      path = require("node:path");
    const files = fs.readdirSync(path.join(f.directory, "pcm-cache"));
    assert.ok(files.length > 0);
    const bytes = fs.readFileSync(path.join(f.directory, "pcm-cache", files[0]));
    assert.notDeepEqual(bytes, f.store.encryption.decryptBytes(bytes));
    assert.equal(fs.statSync(path.join(f.directory, "pcm-cache", files[0])).mode & 0o777, 0o600);
  } finally {
    session.close();
    f.close();
  }
});

test("mid-run ENOSPC discards PCM within budget and completes with all evidence", async (t) => {
  const f = await fixture(340, 0);
  const { runJobLocal } = require("../../src/helpers/speakerInAppCalibration");
  const session = require("../../src/helpers/calibrationAudioSession").createSession(
    f.store,
    f.directory,
    { cacheBytes: 32 }
  );
  const job = () => ({
    state: "running",
    progress: { processedRows: 0, reembeddedRows: 0, bytesRead: 0 },
  });
  const expected = job(),
    actual = job();
  const budget = { notes: 34, rows: 340 };
  try {
    await runJobLocal(expected, f.database, f.store, { kind: "all" }, budget, f.model);
    const fs = require("node:fs");
    const write = fs.writeFileSync;
    let spills = 0,
      failures = 0;
    t.mock.method(fs, "writeFileSync", function (file, ...args) {
      if (String(file).includes("pcm-cache")) {
        spills++;
        if (spills > 1) {
          failures++;
          // Model a partial file left by a mid-run full disk.
          write.call(this, file, Buffer.from("partial"), { mode: 0o600 });
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        }
      }
      return write.call(this, file, ...args);
    });
    const span = session.spanAsync;
    const held = [];
    session.spanAsync = async (...args) => {
      const result = await span(...args);
      held.push(session.metrics.decodedBytes);
      return result;
    };
    await runJobLocal(actual, f.database, session, { kind: "all" }, budget, f.model);
    assert.ok(failures > 0, "the regression must hit the spill failure");
    assert.equal(actual.state, "complete");
    // Cache hits change physical bytes read; report IDs/timestamps are per run.
    const normalize = ({
      generatedAt: _generatedAt,
      id: _id,
      evidence: { bytesRead: _bytesRead, ...evidence },
      ...report
    }) => ({
      ...report,
      evidence,
    });
    assert.deepEqual(normalize(actual.report), normalize(expected.report));
    assert.ok(
      held.length > 0 && held.every((bytes) => bytes >= 0 && bytes <= 32),
      `PCM accounting exceeded budget: ${Math.max(...held)}`
    );
    assert.equal(failures, 1, "after a failed spill, use bounded memory-only eviction");
    assert.deepEqual(fs.readdirSync(require("node:path").join(f.directory, "pcm-cache")), []);
    session.close();
    assert.equal(session.metrics.decodedBytes, 0);
  } finally {
    t.mock.restoreAll();
    session.close();
    f.close();
  }
});

test("cold backup-only worker decrypts approved audio without creating or retaining a key", async (t) => {
  const f = await fixture(34, 1);
  const fs = require("node:fs"),
    path = require("node:path"),
    Module = require("node:module");
  const encryption = f.store.encryption;
  const key = encryption.getWorkerKey();
  const backup = path.join(f.directory, "secure-keys", "master-key-backup.enc");
  const sealed = encryption.encryptBytes(Buffer.from(key.toString("base64")));
  key.fill(0);
  let decrypts = 0,
    ticks = 0;
  const load = Module._load;
  t.mock.method(Module, "_load", function (request, ...args) {
    if (request === "electron")
      return {
        app: { getPath: () => f.directory },
        safeStorage: {
          // Faithful async interface and authenticated backup; synchronous
          // credential access on main would fail this test.
          isEncryptionAvailable() {
            throw new Error("Synchronous safeStorage acquisition");
          },
          decryptString() {
            throw new Error("Synchronous safeStorage acquisition");
          },
          isAsyncEncryptionAvailable: async () => true,
          async decryptStringAsync(bytes) {
            decrypts++;
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { result: encryption.decryptBytes(bytes).toString(), shouldReEncrypt: false };
          },
        },
      };
    if (request === "@napi-rs/keyring")
      throw new Error("Keychain acquisition belongs in the worker");
    return load.call(this, request, ...args);
  });
  const modulePath = require.resolve("../../src/helpers/secretCrypto");
  delete require.cache[modulePath];
  const secrets = require(modulePath);
  f.store.encryption = secrets;
  const { Worker } = require("node:worker_threads");
  class EmptyKeychainWorker extends Worker {
    constructor(_script, options) {
      super(require.resolve("../lib/calibrationKeyWorker"), options);
    }
  }
  const run = async () => {
    const job = {
      state: "running",
      progress: { processedRows: 0, reembeddedRows: 0, bytesRead: 0 },
    };
    await require("../../src/helpers/calibrationWorkerClient").run(
      job,
      f.database,
      f.store,
      { kind: "all" },
      { notes: 34, rows: 34 },
      f.model,
      { WorkerClass: EmptyKeychainWorker, codecModule: require.resolve("../lib/fakeAudioCodec") }
    );
    assert.equal(job.state, "complete");
    return job.report;
  };
  try {
    fs.rmSync(f.store.root, { recursive: true, force: true });
    assert.equal(secrets.getWorkerKey(), null);
    const before = f.database.db.prepare("SELECT total_changes() AS n").get().n;
    const missing = await run();
    assert.equal(missing.evidence.exemplarRows, 0);
    assert.equal(missing.evidence.exclusionCounts.exemplar_key_unavailable, 1);
    assert.equal(fs.existsSync(backup), false, "a missing key must never be created");
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, sealed, { mode: 0o600 });
    const heartbeat = setInterval(() => ticks++, 1);
    let recovered;
    try {
      recovered = await run();
    } finally {
      clearInterval(heartbeat);
    }
    assert.equal(recovered.evidence.exemplarRows, 1);
    assert.equal(recovered.evidence.exclusionCounts.exemplar_key_unavailable, undefined);
    assert.equal(recovered.evidence.revisions[0].exemplarId, "approval-0");
    assert.equal(decrypts, 1);
    assert.ok(ticks > 2, "backup acquisition must allow main-thread heartbeats");
    assert.equal(secrets.getWorkerKey(), null, "the broker must not retain another key copy");
    assert.deepEqual(fs.readFileSync(backup), sealed, "existing backup must never be overwritten");
    assert.equal(f.database.db.prepare("SELECT total_changes() AS n").get().n, before);
  } finally {
    delete require.cache[modulePath];
    t.mock.restoreAll();
    f.close();
  }
});

for (const fault of ["messageerror", "reply delivery"]) {
  test(`worker ${fault} failure rejects visibly without an unhandled rejection`, async () => {
    const f = await fixture(34, 0);
    const { EventEmitter } = require("node:events");
    class BrokenTransportWorker extends EventEmitter {
      constructor() {
        super();
        // The fallback bounds the regression on the original implementation,
        // which ignores messageerror or loses the rejected reply callback.
        this.fallback = setTimeout(
          () => this.emit("message", { type: "failed", error: "test fallback" }),
          50
        );
        queueMicrotask(() => {
          if (fault === "messageerror")
            this.emit("messageerror", new Error("cannot deserialize worker message"));
          else this.emit("message", { type: "embedding", samples: new Float32Array(16) });
        });
      }
      postMessage() {
        throw new Error("cannot deliver worker reply");
      }
      async terminate() {
        clearTimeout(this.fallback);
      }
    }
    const job = { state: "running", progress: {} };
    try {
      await assert.rejects(
        require("../../src/helpers/calibrationWorkerClient").run(
          job,
          f.database,
          f.store,
          { kind: "all" },
          { notes: 34, rows: 34 },
          f.model,
          { WorkerClass: BrokenTransportWorker }
        ),
        fault === "messageerror"
          ? /cannot deserialize worker message/
          : /cannot deliver worker reply/
      );
      assert.equal(job.state, "failed");
      assert.equal(job.report, undefined);
      assert.deepEqual(require("node:fs").readdirSync(`${f.store.root}.calibration-jobs`), []);
    } finally {
      f.close();
    }
  });
}

test("worker setup storage failure marks the job failed", async () => {
  const f = await fixture(34, 0);
  const job = { state: "running", progress: {} };
  try {
    require("node:fs").writeFileSync(`${f.store.root}.calibration-jobs`, "occupied");
    await assert.rejects(
      require("../../src/helpers/calibrationWorkerClient").run(
        job,
        f.database,
        f.store,
        { kind: "all" },
        { notes: 34, rows: 34 },
        f.model
      ),
      { code: "EEXIST" }
    );
    assert.equal(job.state, "failed");
    assert.match(job.error, /EEXIST/);
  } finally {
    f.close();
  }
});

test("pending key broker has a deadline, cancels promptly and erases late keys", async () => {
  const f = await fixture(34, 1);
  const { Worker } = require("node:worker_threads");
  class DeadlineWorker extends Worker {
    constructor(_script, options) {
      super(require.resolve("../lib/calibrationKeyWorker"), {
        ...options,
        workerData: { ...options.workerData, keyRecoveryTimeoutTest: true },
      });
    }
  }
  let requested, resolveKey;
  const request = new Promise((resolve) => {
    requested = resolve;
  });
  f.store.encryption = {
    getWorkerKey: () => null,
    recoverWorkerKey() {
      requested();
      return new Promise((resolve) => {
        resolveKey = resolve;
      });
    },
  };
  const run = (job) =>
    require("../../src/helpers/calibrationWorkerClient").run(
      job,
      f.database,
      f.store,
      { kind: "all" },
      { notes: 34, rows: 34 },
      f.model,
      { WorkerClass: DeadlineWorker, codecModule: require.resolve("../lib/fakeAudioCodec") }
    );
  try {
    const failed = { state: "running", progress: {} };
    await assert.rejects(run(failed), /Calibration key recovery timed out/);
    assert.equal(failed.state, "failed");
    assert.equal(failed.report, undefined);
    const late = Buffer.alloc(32, 7);
    resolveKey(late);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(late, Buffer.alloc(32));
    await request;
    const cancelled = { state: "running", progress: {} };
    const running = run(cancelled);
    // Observe the second actual broker request before cancelling.
    await new Promise((resolve) => {
      requested = resolve;
    });
    const start = performance.now();
    cancelled.abortController.abort();
    await running;
    assert.equal(cancelled.state, "cancelled");
    assert.ok(performance.now() - start < 250);
    const cancelledKey = Buffer.alloc(32, 9);
    resolveKey(cancelledKey);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cancelledKey, Buffer.alloc(32));
    assert.deepEqual(require("node:fs").readdirSync(`${f.store.root}.calibration-jobs`), []);
  } finally {
    f.close();
  }
});
