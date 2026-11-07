const path = require("node:path");
const fs = require("node:fs/promises");
const { Worker } = require("node:worker_threads");

const jobsDirectory = (store) => `${store.root}.calibration-jobs`;

// Called once when IPC is registered, before any calibration can start. Only
// disposable snapshots/cache from interrupted runs live in this directory.
async function recover(store) {
  await fs.rm(jobsDirectory(store), { recursive: true, force: true });
}

async function run(job, database, store, scope, budget, model, options = {}) {
  job.abortController = new AbortController();
  const signal = job.abortController.signal;
  const started = Date.now();
  const base = jobsDirectory(store);
  let directory;
  let worker;
  let heartbeat;
  let lastMessage = Date.now();
  try {
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    directory = await fs.mkdtemp(path.join(base, "run-"));
    if (job.cancelled || signal.aborted) {
      job.cancelled = true;
      job.state = "cancelled";
      return;
    }
    model ||= require("./speakerEmbeddings");
    const WorkerClass = options.WorkerClass || Worker;
    const key = store.encryption.getWorkerKey?.() ?? null;
    try {
      worker = new WorkerClass(path.join(__dirname, "../workers/calibrationWorker.js"), {
        workerData: {
          databasePath: database.db.name,
          activeAccountId: database.activeAccountId ?? null,
          root: store.root,
          now: store.now(),
          directory,
          scope,
          budget,
          key,
          modelPath: model.isAvailable() ? model.getModelPath() : null,
          codecModule: options.codecModule,
          validateReport: options.validateReport,
        },
      });
    } finally {
      key?.fill(0);
    }
    await new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", cancel);
        error ? reject(error) : resolve();
      };
      const cancel = () => {
        job.cancelled = true;
        job.state = "cancelled";
        send({ type: "cancel" });
        finish();
      };
      const send = (message, transfer = []) => {
        if (finished) return;
        try {
          worker.postMessage(message, transfer);
        } catch (error) {
          finish(error);
        }
      };
      signal.addEventListener("abort", cancel, { once: true });
      heartbeat = setInterval(() => {
        job.progress.elapsedMs = Date.now() - started;
        if (job.cancelled) cancel();
        else if (Date.now() - lastMessage > 60000)
          finish(new Error("Calibration worker stopped responding; restart calibration"));
      }, 100);
      worker.on("error", finish);
      worker.on("messageerror", finish);
      worker.on("exit", (code) => {
        if (!finished) finish(new Error(`Calibration worker exited before completion (${code})`));
      });
      worker.on("message", (message) => {
        if (finished) return;
        lastMessage = Date.now();
        if (message.type === "progress") {
          Object.assign(job.progress, message.progress);
          job.progress.elapsedMs = Date.now() - started;
          job.onProgress?.();
        } else if (message.type === "key") {
          Promise.resolve()
            .then(() => store.encryption.recoverWorkerKey?.() ?? null)
            .then((key) => {
              let bytes;
              try {
                if (finished) return;
                // Transfer a dedicated buffer, then erase the broker's copy.
                bytes = key && new Uint8Array(key);
                send({ type: "key", key: bytes }, bytes ? [bytes.buffer] : []);
              } finally {
                key?.fill(0);
                // A failed send leaves the transfer buffer attached locally.
                if (bytes?.byteLength) bytes.fill(0);
              }
            })
            .catch(finish);
        } else if (message.type === "embedding") {
          // ONNX is already isolated in its utility process. Keep that shared
          // lifecycle, but move PCM conversion and all other CPU work away.
          Promise.resolve()
            .then(() => model.extractEmbeddingFromSamples(message.samples))
            .then(
              (vector) => {
                send({ type: "embedding", vector });
              },
              (error) => {
                send({ type: "embedding", error: error.message });
              }
            )
            .catch(finish);
        } else if (message.type === "complete") {
          job.report = message.report;
          job.validationCurrent = message.validationCurrent;
          job.metrics = message.metrics;
          Object.assign(job.progress, message.progress);
          job.state = "complete";
          finish();
        } else if (message.type === "failed") {
          finish(new Error(message.error));
        }
      });
    });
  } catch (error) {
    if (job.cancelled) job.state = "cancelled";
    else {
      job.state = "failed";
      job.error = error.message;
      throw error;
    }
  } finally {
    clearInterval(heartbeat);
    // Allow an async decoder to observe abort and kill its child before thread
    // termination. Termination also interrupts synchronous report/SQLite work.
    if (job.cancelled && worker) await new Promise((resolve) => setTimeout(resolve, 25));
    await worker?.terminate();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    job.progress.elapsedMs = Date.now() - started;
  }
}
module.exports = { run, recover };
