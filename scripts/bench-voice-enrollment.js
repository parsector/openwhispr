// Temporary timing fixture for the 45-minute, two-voice enrolment path.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-voice-bench-"));
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron")
    return { app: { getPath: () => root, getAppPath: () => process.cwd(), isReady: () => false } };
  return originalLoad.call(this, request, parent, isMain);
};
process.env.NODE_ENV = "test";
const DatabaseManager = require("../src/helpers/database");
const enrollment = process.argv.includes("--baseline")
  ? (() => {
      const source = execFileSync("git", ["show", "origin/master:src/helpers/voiceEnrollment.js"], {
        encoding: "utf8",
      });
      const filename = path.join(__dirname, "../src/helpers/voiceEnrollment.baseline.js");
      const baselineModule = new Module(filename, require.main);
      baselineModule.filename = filename;
      baselineModule.paths = Module._nodeModulePaths(path.dirname(filename));
      baselineModule._compile(source, filename);
      return baselineModule.exports;
    })()
  : require("../src/helpers/voiceEnrollment");
const originalResolve = require("../src/helpers/meetingAudioSpan.mjs").resolveMeetingAudioSpan;

function wav(frequency) {
  const buffer = Buffer.alloc(44 + 24000 * 2 * 4);
  buffer.write("RIFF");
  for (let i = 0; i < 24000 * 4; i++)
    buffer.writeInt16LE(Math.round(10000 * Math.sin(i / frequency)), 44 + i * 2);
  return buffer;
}
async function main() {
  const db = new DatabaseManager();
  try {
    const alex = db.createNamedSpeakerProfile("Alex");
    const blair = db.createNamedSpeakerProfile("Blair");
    const saved = db.saveNote("45-minute fixture", "", "meeting");
    const noteId = (saved.note || saved).id;
    const rows = Array.from({ length: 540 }, (_, i) => ({
      id: `row-${i}`,
      source: "mic",
      speaker: `speaker_${i % 2}`,
      speakerLockSource: "user",
      suggestedProfileId: i % 2 ? blair.id : alex.id,
      audioSpan: {
        recordingId: noteId,
        trackId: "mic",
        startSample: i * 5 * 24000,
        endSample: (i * 5 + 4) * 24000,
      },
    }));
    db.updateNote(noteId, { transcript: JSON.stringify({ version: 2, rows }) });
    const tracks = {
      mic: { chunks: [{ startSample: 0, sampleCount: 2700 * 24000 }] },
      system: { chunks: [{ startSample: 0, sampleCount: 2700 * 24000 }] },
    };
    const audioByTrack = { mic: wav(24), system: wav(37) };
    let now = Date.now();
    const startedAt = now;
    let spanCalls = 0;
    let resolverCalls = 0;
    const store = {
      now: () => now,
      status: () => ({ state: "complete", bytes: 1, recordingId: noteId, startedAt, tracks }),
      spanAvailable: () => true,
      span: (_noteId, track) => {
        spanCalls++;
        return { state: "available", wav: audioByTrack[track], partial: false };
      },
      resolveMeetingAudioSpan: (...args) => {
        resolverCalls++;
        return originalResolve(...args);
      },
    };
    const extractor = {
      extractEmbeddingFromSamples: async () =>
        Float32Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)),
    };
    const measure = async (action, work) => {
      spanCalls = 0;
      resolverCalls = 0;
      const start = performance.now();
      const result = await work();
      process.stdout.write(
        `${JSON.stringify({
          action,
          span_calls: spanCalls,
          resolver_calls: resolverCalls,
          ms: Math.round((performance.now() - start) * 10) / 10,
        })}\n`
      );
      return result;
    };
    const candidates = await measure("cold_list", () =>
      enrollment.listCandidates(db, store, alex.id)
    );
    await measure("warm_list", () => enrollment.listCandidates(db, store, alex.id));
    const candidate = candidates[0];
    const first = await measure("play", () => enrollment.play(db, store, candidate.id));
    const second = await measure("second_play", () => enrollment.play(db, store, candidate.id));
    now += 5000;
    await measure("complete", () => enrollment.complete(db, store, candidate.id, second.token));
    await measure("approve", () =>
      enrollment.decide(db, store, extractor, candidate.id, "approve", second.token)
    );
    await measure("post_approve_list", () => enrollment.listCandidates(db, store, alex.id));
    if (first.state !== "available") throw Error("Fixture failed to play");
  } finally {
    db.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
