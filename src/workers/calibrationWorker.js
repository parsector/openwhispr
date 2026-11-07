// No app/database/store constructors here: they migrate, repair and enforce
// retention. This worker only reads a consistent online SQLite snapshot.
const { parentPort, workerData: data, threadId } = require("node:worker_threads");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const SQLite = require("better-sqlite3");
const Database = require("../helpers/database");
const { MeetingAudioStore, defaultCodec } = require("../helpers/meetingAudioStore");
const { runJobLocal, reportStillCurrentLocal } = require("../helpers/speakerInAppCalibration");
const { createSession } = require("../helpers/calibrationAudioSession");

const job = {
  state: "running",
  cancelled: false,
  abortController: new AbortController(),
  progress: { totalRows: 0, processedRows: 0, reembeddedRows: 0, bytesRead: 0, elapsedMs: 0 },
};
const started = Date.now();
let pendingEmbedding;
let pendingKey;
parentPort.on("message", (message) => {
  if (message.type === "cancel") {
    job.cancelled = true;
    job.abortController.abort();
    pendingEmbedding?.reject(new Error("Calibration cancelled"));
    clearTimeout(pendingKey?.timer);
    pendingKey?.reject(new Error("Calibration cancelled"));
    pendingKey = null;
  } else if (message.type === "key") {
    const pending = pendingKey;
    pendingKey = null;
    clearTimeout(pending?.timer);
    const key = message.key && Buffer.from(message.key);
    message.key?.fill(0);
    if (pending) pending.resolve(key);
    else key?.fill(0);
  } else if (message.type === "embedding" && pendingEmbedding) {
    const pending = pendingEmbedding;
    pendingEmbedding = null;
    clearTimeout(pending.timer);
    message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.vector);
  }
});
const publish = () => {
  job.progress.elapsedMs = Date.now() - started;
  parentPort.postMessage({ type: "progress", progress: job.progress });
};
job.onProgress = publish;
const timer = setInterval(publish, 100);

async function encryption() {
  let key = data.key && Buffer.from(data.key);
  data.key?.fill(0);
  data.key = null;
  // An untouched library may not have unlocked audio in the main process yet.
  // Read the existing credential in this worker; never create/replace a key.
  if (!key) {
    try {
      const { Entry } = require("@napi-rs/keyring");
      const stored = new Entry("OpenWhispr", "secrets-master-key").getPassword();
      if (stored) key = Buffer.from(stored, "base64");
    } catch {
      /* A locked credential store remains an explicit refusal. */
    }
  }
  if (key && key.length !== 32) {
    key.fill(0);
    key = null;
  }
  if (!key) {
    key = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingKey = null;
        reject(new Error("Calibration key recovery timed out; restart calibration"));
      }, 60000);
      pendingKey = { resolve, reject, timer };
      parentPort.postMessage({ type: "key" });
    });
  }
  const requireKey = () => {
    if (key?.length !== 32)
      throw Object.assign(new Error("Audio encryption key unavailable"), {
        code: "audio_key_unavailable",
      });
  };
  return {
    encryptBytes(bytes) {
      requireKey();
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
    },
    decryptBytes(bytes) {
      requireKey();
      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(-16));
        return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
      } catch (cause) {
        throw Object.assign(new Error("Audio authentication failed", { cause }), {
          code: "audio_corrupt",
        });
      }
    },
    clear() {
      key?.fill(0);
    },
  };
}

async function main() {
  let source, snapshot, session, cipher;
  try {
    source = new SQLite(data.databasePath, { readonly: true, fileMustExist: true, timeout: 1000 });
    const snapshotPath = path.join(data.directory, "snapshot.db");
    await source.backup(snapshotPath, {
      progress: () => {
        publish();
        return job.cancelled ? 0 : 100;
      },
    });
    source.close();
    source = null;
    fs.chmodSync(snapshotPath, 0o600);
    if (job.cancelled) return;
    snapshot = new SQLite(snapshotPath, { readonly: true, fileMustExist: true, timeout: 1000 });
    const database = Object.assign(Object.create(Database.prototype), {
      db: snapshot,
      activeAccountId: data.activeAccountId,
    });
    cipher = await encryption();
    if (job.cancelled) return;
    const store = Object.assign(Object.create(MeetingAudioStore.prototype), {
      root: data.root,
      database,
      now: () => data.now,
      encryption: cipher,
      codec: data.codecModule ? require(data.codecModule) : defaultCodec,
      legacyRecovery: {
        protects: (noteId) =>
          Boolean(
            snapshot
              .prepare(
                `
        SELECT 1 FROM voice_evidence_provenance p
        LEFT JOIN voice_exemplars e ON e.id=p.sample_id
        LEFT JOIN voice_exemplar_audio a ON a.id=p.sample_id
        WHERE COALESCE(a.note_id, e.note_id)=? AND p.recovery_expires_at>?
        AND ((p.recovery_state='recovered' AND p.recovery_reason='source_repaired') OR
          (a.id IS NULL AND (p.state IN ('pending_recovery','recovery_failed') OR
            (p.state='resolved' AND COALESCE(p.recovery_state,'pending_recovery') IN ('pending_recovery','recovery_failed')))))
        LIMIT 1`
              )
              .get(noteId, data.now)
          ),
      },
    });
    session = createSession(store, data.directory);
    session.metrics.executionThreadId = threadId;
    const model = {
      isAvailable: () => Boolean(data.modelPath),
      getModelPath: () => data.modelPath,
      extractEmbeddingFromSamples: (samples) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingEmbedding = null;
            reject(new Error("Calibration embedding timed out"));
          }, 35000);
          pendingEmbedding = { resolve, reject, timer };
          parentPort.postMessage({ type: "embedding", samples }, [samples.buffer]);
        }),
    };
    if (data.validateReport) {
      const validationCurrent = await reportStillCurrentLocal(
        data.validateReport,
        database,
        session,
        model
      );
      parentPort.postMessage({ type: "complete", validationCurrent, progress: job.progress });
    } else {
      await runJobLocal(job, database, session, data.scope, data.budget, model);
      if (!job.cancelled)
        parentPort.postMessage({
          type: "complete",
          report: job.report,
          progress: job.progress,
          metrics: session.metrics,
        });
    }
  } catch (error) {
    if (!job.cancelled) parentPort.postMessage({ type: "failed", error: error.message });
  } finally {
    clearInterval(timer);
    clearTimeout(pendingEmbedding?.timer);
    clearTimeout(pendingKey?.timer);
    source?.close();
    snapshot?.close();
    session?.close();
    cipher?.clear();
    parentPort.close();
  }
}
main();
