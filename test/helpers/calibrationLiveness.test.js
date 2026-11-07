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
