const { i18nMain } = require("./i18nMain");

function completionDiagnostic(noteId, completion, keyMismatch = false) {
  const cause = completion?.cause || null;
  // Legacy migrations filled both counters with zero. Without a cause or a positive
  // measurement there is no way to distinguish those defaults from measured zero.
  // Derive the display from counters; hadSpeakerEmbeddings keeps its storage meaning.
  const measured =
    completion &&
    Number.isInteger(completion.clusters) &&
    Number.isInteger(completion.vectorsWritten) &&
    completion.clusters >= 0 &&
    completion.vectorsWritten >= 0 &&
    (cause || completion.clusters > 0 || completion.vectorsWritten > 0);
  const reason =
    cause ||
    (keyMismatch
      ? "speaker_id_vs_speaker_key_mismatch"
      : !completion
        ? "no_completion_event"
        : "unknown");
  const causes = {
    diarization_skipped: "skipped",
    diarization_failed: "diarizationFailed",
    embedding_extraction_failed: "extractionFailed",
    model_unavailable: "modelUnavailable",
    no_eligible_segments: "noEligibleSegments",
    speaker_id_vs_speaker_key_mismatch: "keyMismatch",
    no_completion_event: "noCompletion",
    unknown: "unknown",
  };
  const category = reason.startsWith("write_rejected:")
    ? "persistenceRejected"
    : reason.startsWith("audio_state:")
      ? "audioUnavailable"
      : causes[reason] || "unknown";
  const messageKey = `people.calibrationCompletion.${category}`;
  const diagnostic = {
    noteId,
    reason,
    cause,
    messageKey,
    clusters: measured ? completion.clusters : null,
    vectorsWritten: measured ? completion.vectorsWritten : null,
  };
  diagnostic.message = i18nMain.t("people.calibrationCompletionMessage", {
    noteId,
    reason: i18nMain.t(messageKey),
    counters: measured
      ? i18nMain.t("people.calibrationVectorCounts", diagnostic)
      : i18nMain.t("people.calibrationCountersNotRecorded"),
    cause: cause || "",
  });
  return diagnostic;
}

module.exports = { completionDiagnostic };
