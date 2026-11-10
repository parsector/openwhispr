const { createHash } = require("node:crypto");
const { humanProtected, recordedNameAllowed } = require("./speakerRosterPolicy");
const speakerScope = require("./noteSpeakerScope");
const { readTranscriptDocument } = require("./transcriptDocument");

function needsSpeakerReevaluation(row, scope, profiles) {
  if (humanProtected(row) || !row.speakerDecision || recordedNameAllowed(row)) return false;
  const stored = row.speakerDecision;
  // Eligibility/profile failures can recover when the roster or usable voices
  // change. Acoustic vetoes still require an actual row evaluation, never a
  // cached centroid. Unchanged evidence does not repeatedly retry a veto.
  const evaluated =
    stored.rejectionReason === "roster_changed" ? stored.previousDecision || stored : stored;
  const fingerprints = profiles.map((p) => ({
    id: p.id,
    fingerprint: speakerScope.profileFingerprint(p),
  }));
  return (
    (row.audioContentHash && row.audioContentHash !== evaluated.evaluation?.audioContentHash) ||
    evaluated.revision !== scope.revision ||
    JSON.stringify(evaluated.profileFingerprints || []) !== JSON.stringify(fingerprints)
  );
}

async function prepareSpeakerRowEvaluations(
  database,
  identifier,
  noteId,
  runId,
  liveRows,
  audioStore,
  extractor
) {
  const evaluations = new Map();
  if (!audioStore || !extractor?.isAvailable?.()) return evaluations;
  const scope = speakerScope.readScope(database, noteId);
  const profiles = identifier.getSpeakerProfiles?.() || [];
  const persisted = readTranscriptDocument(database.getNote(noteId)?.transcript).rows;
  const byId = new Map((liveRows || []).map((row) => [row.id, row]));
  for (const row of persisted) byId.set(row.id, row);
  for (const row of byId.values()) {
    if (
      (runId && row.diarizationRunId !== runId) ||
      !needsSpeakerReevaluation(row, scope, profiles)
    )
      continue;
    const span = row.audioSpan;
    if (!span || span.recordingId !== audioStore.status(noteId).recordingId) continue;
    try {
      const audio = audioStore.span(
        noteId,
        span.trackId,
        span.startSample / 24000,
        span.endSample / 24000
      );
      if (audio.state !== "available" || audio.partial) continue;
      const samples = require("./speakerClusterSplit").wavTo16kSamples(audio.wav);
      if (!samples?.length) continue;
      const embedding = await extractor.extractEmbeddingFromSamples(samples);
      if (!embedding) continue;
      const audioContentHash = createHash("sha256")
        .update(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
        .digest("hex");
      evaluations.set(row.id, {
        embedding,
        audioContentHash,
        previousDecisionId: row.speakerDecision.decisionId,
      });
    } catch {
      // Unavailable audio leaves the existing veto in place.
    }
  }
  return evaluations;
}
module.exports = { needsSpeakerReevaluation, prepareSpeakerRowEvaluations };
