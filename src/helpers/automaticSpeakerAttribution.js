import {
  humanProtected,
  recordedNameAllowed,
  eligible,
  decisionCurrentForNote,
} from "./speakerRosterPolicy.js";

const ATTRIBUTION = [
  "speakerName",
  "speakerIsPlaceholder",
  "suggestedName",
  "suggestedProfileId",
  "speakerStatus",
  "speakerLocked",
  "speakerLockSource",
  "machineReason",
  "speakerDecision",
  "uncertainty",
];
const copyAttribution = (target, source) => {
  const result = { ...target };
  for (const field of ATTRIBUTION) result[field] = source[field];
  return result;
};
const unknown = (row, decision) => ({
  ...row,
  speakerName: undefined,
  suggestedName: undefined,
  suggestedProfileId: undefined,
  speakerIsPlaceholder: true,
  speakerStatus: "provisional",
  machineReason: undefined,
  speakerDecision: decision,
});
const sameSpan = (a, b) =>
  a &&
  b &&
  ["recordingId", "trackId", "startSample", "endSample"].every((key) => a[key] === b[key]);

export function currentSpeakerDecision(decision, scope) {
  if (!scope) return true; // historical projections cannot invent a note context
  if ("participants" in scope || "id" in scope) return decisionCurrentForNote(decision, scope);
  if (
    decision?.noteId === scope.noteId &&
    decision?.revision === scope.revision &&
    decision?.rosterRevision === scope.rosterRevision
  )
    return true;
  // Retired calendar-id field is irrelevant to declared note scope.
  try {
    const legacy = JSON.parse(decision?.revision);
    if (!Array.isArray(legacy) || legacy.length !== 6) return false;
    if (
      decision.source === "linked_event" &&
      scope.source === "none" &&
      scope.unrestricted &&
      decision.noteId === scope.noteId &&
      decision.rosterRevision === scope.rosterRevision
    )
      return true;
    legacy.splice(3, 1);
    return JSON.stringify(legacy) === scope.revision;
  } catch {
    return false;
  }
}

// Only a new evaluation of this row's canonical audio can supersede its veto.
// A new decision id, cluster, recording alias, track or trimmed span proves nothing.
export function freshSpeakerEvaluation(row, stored, scope, incoming) {
  const next = incoming?.speakerDecision;
  const proof = next?.evaluation;
  const hash = row.audioContentHash || stored?.evaluation?.audioContentHash;
  const fingerprint = next?.profileFingerprints?.find(
    (item) => item.id === next.acceptedProfileId
  )?.fingerprint;
  const currentFingerprint = scope?.profileFingerprints?.find(
    (item) => item.id === next.acceptedProfileId
  )?.fingerprint;
  return !!(
    proof &&
    proof.rowId === row.id &&
    proof.previousDecisionId === stored?.decisionId &&
    next.decisionId &&
    next.decisionId !== stored?.decisionId &&
    proof.audioContentHash &&
    proof.audioContentHash === incoming.audioContentHash &&
    (hash
      ? hash === proof.audioContentHash
      : sameSpan(row.audioSpan, incoming.audioSpan) && sameSpan(row.audioSpan, proof.audioSpan)) &&
    proof.rosterRevision === next.rosterRevision &&
    proof.revision === next.revision &&
    currentSpeakerDecision(next, scope || stored) &&
    fingerprint &&
    proof.profileFingerprint === fingerprint &&
    (!scope?.profileFingerprints || currentFingerprint === fingerprint)
  );
}

// Main and renderer use this same boundary. `restorationRowIds` is the action's
// affected set, never the full transcript returned alongside an action.
export function resolveAutomaticSpeaker(
  row,
  storedDecision,
  scope,
  incoming,
  { restorationRowIds = [] } = {}
) {
  const restoring = restorationRowIds.includes(row.id);
  if (humanProtected(row) && !restoring) {
    return { ...copyAttribution(incoming, row), speaker: row.speaker };
  }
  if (humanProtected(incoming)) return incoming;
  let next = incoming;
  if (
    storedDecision &&
    !recordedNameAllowed({ speakerDecision: storedDecision }) &&
    recordedNameAllowed(next) &&
    !freshSpeakerEvaluation(row, storedDecision, scope, next)
  ) {
    return unknown(
      {
        ...next,
        audioSpan: row.id === next.id ? row.audioSpan : next.audioSpan,
        audioContentHash: row.id === next.id ? row.audioContentHash : undefined,
        uncertainty: row.uncertainty,
      },
      storedDecision
    );
  }
  const evidence = next.speakerDecision;
  if (evidence && !currentSpeakerDecision(evidence, scope)) {
    next = unknown(next, {
      ...evidence,
      acceptedProfileId: null,
      acceptedIdentity: null,
      rejectionReason: "roster_changed",
      previousDecision: evidence,
      ...(scope && "id" in scope
        ? {
            noteId: scope.id,
            rosterRevision: scope.speaker_roster_revision ?? 0,
            source: scope.participants == null ? "none" : "note",
            rawRoster: scope.participants ?? null,
          }
        : {}),
    });
  }
  if (!recordedNameAllowed(next)) return unknown(next, next.speakerDecision);
  if (
    next.overlap ||
    [
      "too_short",
      "close_match",
      "not_sure",
      "overlapping_speech",
      "possible_mixed_speakers",
    ].includes(next.uncertainty?.reason)
  )
    return unknown(
      next,
      next.speakerDecision
        ? {
            ...next.speakerDecision,
            acceptedProfileId: null,
            acceptedIdentity: null,
            rejectionReason: "unsafe_span",
          }
        : undefined
    );

  if (
    next.speakerDecision &&
    scope?.eligibleProfileIds &&
    !eligible(scope, next.speakerDecision.acceptedProfileId)
  )
    return unknown(next, {
      ...next.speakerDecision,
      acceptedProfileId: null,
      acceptedIdentity: null,
      rejectionReason: "outside_roster",
    });
  return next;
}
