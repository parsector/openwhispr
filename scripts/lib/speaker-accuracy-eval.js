function evaluateSpeakerAccuracy(truth, finalRows, durationSeconds, actions = null) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw Error("Invalid audio duration");
  if (!Array.isArray(truth) || !truth.length || !Array.isArray(finalRows)) throw Error("Missing labelled rows");
  const byId = new Map(finalRows.map((row) => [row.id, row]));
  if (byId.size !== finalRows.length) throw Error("Duplicate final row ids");
  const seen = new Set();
  const counts = { rows: truth.length, nonOverlapRows: 0, correctNamedRows: 0,
    wrongNamedRows: 0, refusedRows: 0, unknownRows: 0, uncertainRows: 0,
    overlapRows: 0, overlapDetectedRows: 0, overlapRefusedRows: 0,
    nonOverlapRefusedRows: 0, changedAfterFinalRows: 0, alignedRows: 0,
    lockedRows: 0 };
  for (const label of truth) {
    if (!label.rowId || seen.has(label.rowId) || typeof label.person !== "string")
      throw Error("Invalid or duplicate truth row");
    seen.add(label.rowId);
    const row = byId.get(label.rowId);
    if (!row) throw Error(`Missing final row ${label.rowId}`);
    const refused = !row.speakerName || !!row.speakerIsPlaceholder;
    if (refused) counts.refusedRows += 1;
    if (!row.speakerName) counts.unknownRows += 1;
    if (row.uncertainty && row.uncertainty.reason !== "changed_after_final") counts.uncertainRows += 1;
    if (row.changedAfterFinal || row.uncertainty?.reason === "changed_after_final")
      counts.changedAfterFinalRows += 1;
    if (row.wordTimings?.length && row.audioSpan) counts.alignedRows += 1;
    if (row.speakerLocked) counts.lockedRows += 1;
    if (label.overlap) {
      counts.overlapRows += 1;
      if (row.uncertainty?.reason === "overlapping_speech") counts.overlapDetectedRows += 1;
      if (refused) counts.overlapRefusedRows += 1;
    } else {
      counts.nonOverlapRows += 1;
      if (refused) counts.nonOverlapRefusedRows += 1;
      else if (row.speakerName === label.person) counts.correctNamedRows += 1;
      else counts.wrongNamedRows += 1;
    }
  }
  const ratio = (part, whole) => whole ? part / whole : null;
  const correctionCount = actions == null ? null : actions.filter((action) =>
    ["correction", "split"].includes(action.kind)).length;
  return { counts, rates: {
    rightPersonAfterFinal: ratio(counts.correctNamedRows, counts.nonOverlapRows),
    namedTurnAccuracy: ratio(counts.correctNamedRows,
      counts.correctNamedRows + counts.wrongNamedRows),
    falseName: ratio(counts.wrongNamedRows, counts.nonOverlapRows),
    refusal: ratio(counts.refusedRows, counts.rows),
    nonOverlapRefusal: ratio(counts.nonOverlapRefusedRows, counts.nonOverlapRows),
    overlapDetection: ratio(counts.overlapDetectedRows, counts.overlapRows),
    overlapRefusal: ratio(counts.overlapRefusedRows, counts.overlapRows),
    finalPassChange: ratio(counts.changedAfterFinalRows, counts.rows),
    alignmentCoverage: ratio(counts.alignedRows, counts.rows),
    correctionsPerMinute: correctionCount == null ? null : correctionCount / (durationSeconds / 60),
  }, correctionCount, durationSeconds };
}

module.exports = { evaluateSpeakerAccuracy };
