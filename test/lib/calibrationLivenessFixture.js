// Isolated, real SQLite and retained-audio store. No owner data or keychain.
const createTempDir = require("./tempDir");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
let currentDirectory;

async function fixture(
  count = 2216,
  approved = 90,
  libraryRoot = path.resolve(__dirname, "../..")
) {
  const parent = path.join(process.cwd(), "node_modules/.cache");
  const directory = createTempDir("calibration-", parent);
  currentDirectory = directory;
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron")
      return {
        app: {
          getPath: () => currentDirectory,
          getAppPath: () => process.cwd(),
          isReady: () => false,
        },
      };
    return load.call(this, request, parent, isMain);
  };
  process.env.NODE_ENV = "test";
  const Database = require(path.join(libraryRoot, "src/helpers/database"));
  const { MeetingAudioStore, RATE } = require(
    path.join(libraryRoot, "src/helpers/meetingAudioStore")
  );
  const audio = require(path.join(libraryRoot, "src/helpers/voiceExemplarAudio"));
  const database = new Database();
  Module._load = load;
  const key = crypto.randomBytes(32);
  const encryption = {
    getWorkerKey: () => Buffer.from(key),
    encryptBytes(bytes) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
    },
    decryptBytes(bytes) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
    },
  };
  let decodes = 0;
  const baseCodec = require("./fakeAudioCodec");
  const codec = {
    encode: baseCodec.encode,
    decode(bytes) {
      decodes++;
      return baseCodec.decode(bytes);
    },
    async decodeAsync(bytes) {
      await new Promise((resolve) => setImmediate(resolve));
      decodes++;
      return baseCodec.decode(bytes);
    },
  };
  const clock = Date.now();
  const store = new MeetingAudioStore(path.join(directory, "audio"), {
    database,
    encryption,
    codec,
    now: () => clock,
  });
  store.cancelRecovery();
  // Fixture construction is outside the timed run; avoid retention sweeps on
  // every synthetic append. Calibration itself never calls enforce().
  store.enforce = () => ({ usedBytes: 0, budgetBytes: 2 ** 40 });
  const profiles = Array.from({ length: 30 }, (_, i) => {
    const person = database.createNamedSpeakerProfile(`Person ${i}`);
    const vector = new Float32Array(512);
    vector[i] = 1;
    database.db
      .prepare("UPDATE speaker_profiles SET embedding=? WHERE id=?")
      .run(Buffer.from(vector.buffer), person.id);
    return { ...person, vector };
  });
  const pcm = Buffer.alloc(RATE * 2 * 5);
  const notes = [];
  let serial = 0;
  for (let n = 0; n < 34; n++) {
    const saved = database.saveNote(`Synthetic ${n}`, "", "meeting");
    const id = (saved.note || saved).id;
    const size = Math.floor(count / 34) + Number(n < count % 34);
    store.begin(id);
    for (let c = 0; c < Math.ceil((size * 2) / 5); c++) store.append(id, "mic", pcm);
    store.finish(id);
    const status = store.status(id);
    const rows = Array.from({ length: size }, (_, r) => {
      const index = serial++;
      return {
        id: `row-${index}`,
        source: "mic",
        speaker: `s-${index % 30}`,
        speakerName: `Person ${index % 30}`,
        speakerLockSource: "user",
        text: "Synthetic evidence",
        audioSpan: {
          recordingId: status.recordingId,
          trackId: "mic",
          startSample: r * 2 * RATE,
          endSample: (r * 2 + 2) * RATE,
        },
      };
    });
    database.updateNote(id, { transcript: JSON.stringify({ version: 2, rows }) });
    notes.push({ id, rows, status });
  }
  // Spread approvals over all notes; each of 30 people has three approvals.
  const approvedWav = store.span(notes[0].id, "mic", 0, 2).wav;
  for (let i = 0; i < approved; i++) {
    const note = notes[i % 34];
    const row = note.rows[Math.floor(i / 34)];
    const person = profiles[i % 30];
    const candidate = {
      id: `approval-${i}`,
      profileId: person.id,
      noteId: note.id,
      rowIds: [row.id],
      revision: `revision-${i}`,
      track: "mic",
      startSample: row.audioSpan.startSample,
      endSample: row.audioSpan.endSample,
      durationSeconds: 2,
      recordingId: note.status.recordingId,
      meetingDate: new Date().toISOString(),
    };
    audio.save(
      database.db,
      candidate,
      approvedWav,
      encryption.encryptBytes(approvedWav),
      Buffer.from(person.vector.buffer)
    );
    database.db
      .prepare(
        "INSERT INTO voice_evidence_provenance(sample_id, profile_id, state, recording_id) VALUES (?, ?, 'resolved', ?)"
      )
      .run(candidate.id, person.id, candidate.recordingId);
  }
  let provenanceReads = 0;
  const provenance = store.recordingProvenance.bind(store);
  store.recordingProvenance = (...args) => {
    provenanceReads++;
    return provenance(...args);
  };
  decodes = 0;
  const modelPath = path.join(directory, "model.onnx");
  fs.writeFileSync(modelPath, "synthetic model identity; inference is a deterministic async stub");
  const model = {
    isAvailable: () => true,
    getModelPath: () => modelPath,
    extractEmbeddingFromSamples: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return profiles[0].vector;
    },
  };
  return {
    database,
    store,
    model,
    directory,
    libraryRoot,
    counters: () => ({ provenanceReads, decodes }),
    close() {
      database.db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function measure(f, { count = 2216, cancel = false, cancelAfterRows = 0 } = {}) {
  const { runJob } = require(path.join(f.libraryRoot, "src/helpers/speakerInAppCalibration"));
  const job = {
    state: "running",
    cancelled: false,
    progress: { totalRows: 0, processedRows: 0, reembeddedRows: 0, bytesRead: 0, elapsedMs: 0 },
  };
  const started = performance.now();
  let lastCpu = process.threadCpuUsage();
  let maxMainThreadCpuSliceMs = 0;
  let last = started,
    longestStallMs = 0,
    ticks = 0,
    progressTicks = 0,
    previous = -1;
  let cancelRequested,
    peakRss = process.memoryUsage().rss;
  const cancelJob = () => {
    cancelRequested ||= performance.now();
    job.cancelled = true;
    job.abortController?.abort();
  };
  const onMessage = (message) => {
    if (message === "cancel") cancelJob();
  };
  process.on("message", onMessage);
  let progressEvents = 0;
  job.onProgress = () => {
    progressEvents++;
  };
  process.send?.({ type: "ready" });
  const timer = setInterval(() => {
    const now = performance.now();
    const cpu = process.threadCpuUsage();
    maxMainThreadCpuSliceMs = Math.max(
      maxMainThreadCpuSliceMs,
      (cpu.user + cpu.system - lastCpu.user - lastCpu.system) / 1000
    );
    lastCpu = cpu;
    longestStallMs = Math.max(longestStallMs, now - last - 5);
    last = now;
    ticks++;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if (job.progress.processedRows !== previous) {
      progressTicks++;
      previous = job.progress.processedRows;
    }
    if (cancel && !cancelRequested && job.progress.processedRows >= cancelAfterRows) cancelJob();
    process.send?.({ type: "heartbeat", processedRows: job.progress.processedRows });
  }, 5);
  try {
    await runJob(job, f.database, f.store, { kind: "all" }, { notes: 34, rows: count }, f.model, {
      codecModule: require.resolve("./fakeAudioCodec"),
    });
    const finished = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      count,
      wallMs: +(finished - started).toFixed(1),
      longestStallMs: +longestStallMs.toFixed(1),
      maxMainThreadCpuSliceMs: +maxMainThreadCpuSliceMs.toFixed(1),
      ticks,
      progressTicks,
      progressEvents,
      cancelLatencyMs: cancelRequested ? +(finished - cancelRequested).toFixed(1) : null,
      cancelDispatchDelayMs:
        cancelRequested && !cancelAfterRows ? +(cancelRequested - started - 5).toFixed(1) : null,
      peakRssMiB: +(Math.max(peakRss, process.resourceUsage().maxRSS * 1024) / 1048576).toFixed(1),
      state: job.state,
      processedRows: job.progress.processedRows,
      ...f.counters(),
      ...job.metrics,
    };
  } finally {
    clearInterval(timer);
    process.off("message", onMessage);
  }
}
module.exports = { fixture, measure };
