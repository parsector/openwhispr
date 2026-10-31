// These are search candidates, not owner-calibrated defaults. Reports retain
// every outcome so the tradeoff can be inspected before applying anything.
const CANDIDATES = Object.freeze({
  similarityFloor: [0.55, 0.6, 0.65, 0.7],
  runnerUpMargin: [0.03, 0.05, 0.08],
  minimumVoicedSeconds: [1.5, 2, 3],
  overlapToleranceSeconds: [0.05, 0.1, 0.2],
});

const rate = (part, total) => (total ? part / total : null);

function scoreCombination(rows, thresholds) {
  let right = 0,
    wrong = 0,
    refused = 0,
    overlapDetected = 0;
  let overlapCount = 0,
    nonOverlapCount = 0;
  for (const row of rows) {
    const detected = row.overlapSeconds >= thresholds.overlapToleranceSeconds;
    if (row.trueOverlap) {
      overlapCount++;
      if (detected) overlapDetected++;
    } else nonOverlapCount++;
    const accepted =
      !detected &&
      row.voicedSeconds >= thresholds.minimumVoicedSeconds &&
      row.bestScore >= thresholds.similarityFloor &&
      row.bestScore - row.runnerUpScore >= thresholds.runnerUpMargin;
    if (!accepted) refused++;
    else if (!row.trueOverlap && row.bestName === row.truePerson) right++;
    else wrong++;
  }
  return {
    rightPersonRate: rate(right, nonOverlapCount),
    refusalRate: rate(refused, rows.length),
    overlapDetectionRate: rate(overlapDetected, overlapCount),
    right,
    wrong,
    refused,
    overlapDetected,
    overlapCount,
  };
}

function sweepCalibration(rows, durationSeconds, candidates = CANDIDATES) {
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  )
    throw Error("Calibration requires labelled rows and audio duration");
  for (const row of rows) {
    if (
      !row.rowId ||
      typeof row.truePerson !== "string" ||
      !row.truePerson ||
      !Number.isFinite(row.bestScore) ||
      !Number.isFinite(row.runnerUpScore) ||
      !Number.isFinite(row.voicedSeconds) ||
      !Number.isFinite(row.overlapSeconds) ||
      typeof row.trueOverlap !== "boolean"
    )
      throw Error(
        `Row ${row.rowId || "<unknown>"} needs a reviewed person, overlap label, and measured audio scores`
      );
  }
  const table = [];
  for (const similarityFloor of candidates.similarityFloor)
    for (const runnerUpMargin of candidates.runnerUpMargin)
      for (const minimumVoicedSeconds of candidates.minimumVoicedSeconds)
        for (const overlapToleranceSeconds of candidates.overlapToleranceSeconds) {
          const thresholds = {
            similarityFloor,
            runnerUpMargin,
            minimumVoicedSeconds,
            overlapToleranceSeconds,
          };
          table.push({ ...thresholds, ...scoreCombination(rows, thresholds) });
        }
  // A wrong person costs more than a refusal. An overlap miss also costs more
  // than a refusal. Ties favor the stricter margin, then shorter voice minimum.
  const rank = (row) =>
    row.right * 2 - row.wrong * 4 - row.refused - (row.overlapCount - row.overlapDetected) * 3;
  const winner = [...table].sort(
    (a, b) =>
      rank(b) - rank(a) ||
      b.runnerUpMargin - a.runnerUpMargin ||
      a.minimumVoicedSeconds - b.minimumVoicedSeconds ||
      a.overlapToleranceSeconds - b.overlapToleranceSeconds ||
      b.similarityFloor - a.similarityFloor
  )[0];
  const recommended = Object.fromEntries(Object.keys(CANDIDATES).map((key) => [key, winner[key]]));
  const nonOverlap = rows.filter((row) => !row.trueOverlap);
  const overlap = rows.filter((row) => row.trueOverlap);
  const metrics = {
    rightPersonRate: rate(
      nonOverlap.filter((row) => (row.machineLabel ?? row.currentLabel) === row.truePerson).length,
      nonOverlap.length
    ),
    refusalRate: rate(
      rows.filter((row) => !(row.machineLabel ?? row.currentLabel)).length,
      rows.length
    ),
    overlapDetectionRate: rate(
      overlap.filter((row) => row.currentOverlapDetected).length,
      overlap.length
    ),
    finalPassChangeRate: rate(rows.filter((row) => row.finalPassChanged).length, rows.length),
    correctionsPerMinute:
      new Set(
        rows.flatMap((row) =>
          row.ownerCorrectionActionIds?.length
            ? row.ownerCorrectionActionIds
            : row.corrected
              ? [`row:${row.rowId}`]
              : []
        )
      ).size /
      (durationSeconds / 60),
  };
  return {
    metrics,
    table,
    recommended,
    evidence: {
      rowCount: rows.length,
      overlapRows: overlap.length,
      durationSeconds,
      winner: scoreCombination(rows, recommended),
      objective: "2 × right − 4 × wrong − refusal − 3 × missed overlap",
    },
  };
}

module.exports = { CANDIDATES, sweepCalibration };
