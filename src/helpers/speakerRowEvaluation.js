const { humanProtected, recordedNameAllowed } = require("./speakerRosterPolicy");
const speakerScope = require("./noteSpeakerScope");
const { readTranscriptDocument } = require("./transcriptDocument");
const { evaluateCanonicalSpeakerRow } = require("./automaticSpeakerAttribution");

// The decoder runs outside the event loop, with bounded output and runtime.
function decodeAudio(wav) {
  return new Promise((resolve, reject) => {
    const child = require("node:child_process").execFile(
      require("./ffmpegUtils").getFFmpegPath(),
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "wav",
        "-i",
        "pipe:0",
        "-f",
        "f32le",
        "-ar",
        "16000",
        "-ac",
        "1",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 10000, windowsHide: true },
      (error, stdout) => {
        if (error) return reject(error);
        const samples = new Float32Array(stdout.length / 4);
        new Uint8Array(samples.buffer).set(stdout);
        resolve(samples);
      }
    );
    child.stdin.on("error", () => {});
    child.stdin.end(wav);
  });
}
function evaluationSnapshot(profiles) {
  return profiles.map((p) => ({ id: p.id, fingerprint: speakerScope.profileFingerprint(p) }));
}
function needsSpeakerReevaluation(
  row,
  scope,
  profiles,
  fingerprints = evaluationSnapshot(profiles)
) {
  if (humanProtected(row) || !row.speakerDecision || recordedNameAllowed(row)) return false;
  const stored = row.speakerDecision;
  const evaluated =
    stored.rejectionReason === "roster_changed" ? stored.previousDecision || stored : stored;
  return (
    (row.audioContentHash && row.audioContentHash !== evaluated.evaluation?.audioContentHash) ||
    evaluated.revision !== scope.revision ||
    JSON.stringify(evaluated.profileFingerprints || []) !== JSON.stringify(fingerprints)
  );
}
function rowForSpeakerEvaluation(row, evaluated) {
  if (!evaluated) return row;
  const reason = row.uncertainty?.reason;
  const replacementSpan =
    evaluated.evaluation?.audioTransition?.kind === "replacement" && evaluated.audioSpan;
  const longerReplacement =
    reason === "too_short" &&
    replacementSpan &&
    !require("./speakerUncertainty").shortSpanReason({
      start: replacementSpan.startSample / 24000,
      end: replacementSpan.endSample / 24000,
    });
  return ["not_sure", "close_match"].includes(reason) || longerReplacement
    ? { ...row, uncertainty: undefined }
    : row;
}
async function prepareSpeakerRowEvaluations(
  database,
  identifier,
  noteId,
  runId,
  liveRows,
  audioStore,
  extractor,
  { replacements = new Map(), evaluateEmbedding } = {}
) {
  const result = new Map();
  if (!audioStore || !extractor?.isAvailable?.()) return result;
  const profiles = identifier.getSpeakerProfiles?.() || [];
  const note = database.getNote(noteId);
  const scope = speakerScope.readScope(database, noteId, profiles, note);
  const fingerprints = evaluationSnapshot(profiles);
  scope.profileFingerprints = fingerprints;
  const evaluate =
    evaluateEmbedding ||
    ((embedding, row) =>
      identifier.matchEligibleCluster?.(row.speaker, embedding, {
        profiles,
        scope,
        evaluateRow: true,
      }));
  const fingerprintIndex = new Map(
    fingerprints.map((profile) => [profile.id, profile.fingerprint])
  );
  const persisted = readTranscriptDocument(note?.transcript).rows;
  const byId = new Map((liveRows || []).map((row) => [row.id, row]));
  for (const row of persisted) byId.set(row.id, row);
  for (const row of byId.values()) {
    if (
      (runId && row.diarizationRunId !== runId) ||
      (!replacements.has(row.id) && !needsSpeakerReevaluation(row, scope, profiles, fingerprints))
    )
      continue;
    // Yield even when a test extractor or an unavailable-audio read resolves
    // immediately. A large note must leave time for IPC and UI heartbeats.
    await new Promise((resolve) => setImmediate(resolve));
    try {
      const evaluated = await evaluateCanonicalSpeakerRow(row, {
        noteId,
        scope,
        profileFingerprints: fingerprints,
        fingerprintIndex,
        audioStore,
        extractor,
        decodeAudio,
        evaluateEmbedding: (embedding, candidate) =>
          evaluate(
            embedding,
            rowForSpeakerEvaluation(candidate, {
              audioSpan: replacements.get(row.id)?.audioSpan,
              evaluation: { audioTransition: replacements.get(row.id) },
            })
          ),
        replacement: replacements.get(row.id),
      });
      if (evaluated) result.set(row.id, evaluated);
    } catch {
      // Unavailable original audio retains the veto. An explicit replacement
      // can be evaluated independently against its retained parent identity.
    }
  }
  return result;
}
module.exports = {
  needsSpeakerReevaluation,
  prepareSpeakerRowEvaluations,
  evaluationSnapshot,
  rowForSpeakerEvaluation,
};
