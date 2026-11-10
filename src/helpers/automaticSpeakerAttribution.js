import {
  humanProtected,
  recordedNameAllowed,
  eligible,
  decisionCurrentForNote,
  resolveSpeakerRoster,
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
  for (const field of ATTRIBUTION) {
    if (source[field] === undefined) delete result[field];
    else result[field] = source[field];
  }
  if (source.speakerAssignment !== undefined || target.speakerAssignment !== undefined)
    result.speakerAssignment = source.speakerAssignment;
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

// A batch owns its snapshot. Never cache a mutable note itself: the next
// roster notification or completion retry must resolve the new generation.
const preparedRosters = new WeakMap();
export function prepareAutomaticSpeakerScope(scope) {
  if (!scope || !("participants" in scope || "id" in scope) || preparedRosters.has(scope))
    return scope;
  const snapshot = { ...scope };
  preparedRosters.set(snapshot, resolveSpeakerRoster(snapshot, null));
  return snapshot;
}

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

// Handles live only in this module's closure. JSON, copies, hashes and decision
// ids cannot enter this map. Only evaluating retained canonical audio issues one.
const evaluations = new WeakMap();
export async function evaluateCanonicalSpeakerRow(
  row,
  {
    noteId,
    scope,
    profileFingerprints,
    fingerprintIndex,
    audioStore,
    extractor,
    decodeAudio,
    evaluateEmbedding,
    replacement,
  }
) {
  const originalSpan = row.audioSpan;
  const span = replacement?.audioSpan || originalSpan;
  if (!scope || !row.id || !row.speakerDecision || !span) return null;
  if (
    !replacement &&
    (row.overlap ||
      ["too_short", "overlapping_speech", "possible_mixed_speakers"].includes(
        row.uncertainty?.reason
      ))
  )
    return null;
  if (replacement && !["replacement", "reupload"].includes(replacement.kind)) return null;
  if (
    replacement &&
    (replacement.previousDecisionId !== row.speakerDecision.decisionId ||
      replacement.parentRecordingId !== originalSpan?.recordingId)
  )
    return null;
  if (
    replacement?.kind === "reupload" &&
    ["trackId", "startSample", "endSample"].some((key) => span[key] !== originalSpan?.[key])
  )
    return null;
  if (span.recordingId !== audioStore.status(noteId).recordingId) return null;
  const read = audioStore.spanAsync?.bind(audioStore) || audioStore.span.bind(audioStore);
  const audio = await read(noteId, span.trackId, span.startSample / 24000, span.endSample / 24000);
  if (audio.state !== "available" || audio.partial) return null;
  const samples = await decodeAudio(audio.wav);
  if (!samples?.length) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  );
  const audioContentHash = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  if (
    (!replacement || replacement.kind === "reupload") &&
    row.audioContentHash &&
    row.audioContentHash !== audioContentHash
  )
    return null;
  if (replacement?.kind === "reupload" && !row.audioContentHash) return null;
  const embedding = await extractor.extractEmbeddingFromSamples(samples);
  if (!embedding || !evaluateEmbedding) return null;
  const match = await evaluateEmbedding(embedding, row);
  if (!match?.speakerDecision?.decisionId) return null;
  const evaluatedDecision = structuredClone(match.speakerDecision);
  delete evaluatedDecision.evaluation;
  const evaluation = Object.freeze({
    rowId: row.id,
    previousDecisionId: row.speakerDecision.decisionId,
    audioContentHash,
    audioSpan: Object.freeze({ ...span }),
    revision: scope.revision,
    rosterRevision: scope.rosterRevision,
    ...(replacement
      ? {
          audioTransition: Object.freeze({
            kind: replacement.kind,
            parentRecordingId: originalSpan.recordingId,
            previousAudioSpan: Object.freeze({ ...originalSpan }),
            canonicalHashMatched: row.audioContentHash === audioContentHash,
          }),
        }
      : {}),
  });
  evaluations.set(evaluation, {
    rowId: row.id,
    previousDecisionId: row.speakerDecision.decisionId,
    evaluatedDecisionId: match.speakerDecision.decisionId,
    evaluatedDecision,
    acceptedProfileId: match.speakerDecision.acceptedProfileId,
    acceptedName: match.profile?.display_name,
    originalSpan: { ...originalSpan },
    originalHash: row.audioContentHash,
    span: { ...span },
    audioContentHash,
    noteId,
    revision: scope.revision,
    rosterRevision: scope.rosterRevision,
    fingerprints:
      fingerprintIndex || new Map(profileFingerprints.map((p) => [p.id, p.fingerprint])),
    replacement: !!replacement,
    consumed: false,
  });
  return {
    embedding,
    match,
    evaluation,
    audioContentHash,
    audioSpan: { ...span },
    previousDecisionId: row.speakerDecision.decisionId,
  };
}

function evaluationRefusal(row, stored, scope, incoming, consume = false) {
  const next = incoming?.speakerDecision;
  const proof = next?.evaluation;
  const issued = proof && evaluations.get(proof);
  if (!issued) return "missing_proof";
  if (issued.consumed) return "reused_proof";
  if (
    issued.rowId !== row.id ||
    incoming.id !== row.id ||
    issued.previousDecisionId !== stored?.decisionId ||
    !next.decisionId ||
    next.decisionId === stored?.decisionId ||
    next.decisionId !== issued.evaluatedDecisionId
  )
    return "row_binding";
  if (
    !scope ||
    !currentSpeakerDecision(next, scope) ||
    issued.noteId !== next.noteId ||
    issued.revision !== next.revision ||
    issued.rosterRevision !== next.rosterRevision
  )
    return "revision";
  if (
    !sameSpan(row.audioSpan, issued.originalSpan) ||
    row.audioContentHash !== issued.originalHash ||
    !sameSpan(incoming.audioSpan, issued.span) ||
    incoming.audioContentHash !== issued.audioContentHash
  )
    return "audio";
  if (!issued.replacement && !sameSpan(row.audioSpan, incoming.audioSpan)) return "audio";
  const fingerprint = next.profileFingerprints?.find(
    (p) => p.id === next.acceptedProfileId
  )?.fingerprint;
  const current = scope.profileFingerprints?.find(
    (p) => p.id === next.acceptedProfileId
  )?.fingerprint;
  if (
    next.acceptedProfileId !== issued.acceptedProfileId ||
    (issued.acceptedName &&
      (incoming.speakerName || incoming.suggestedName) !== issued.acceptedName) ||
    !fingerprint ||
    issued.fingerprints.get(next.acceptedProfileId) !== fingerprint ||
    (scope.profileFingerprints && current !== fingerprint)
  )
    return "profile";
  if (consume) issued.consumed = true;
  return null;
}

export function freshSpeakerEvaluation(row, stored, scope, incoming) {
  return !evaluationRefusal(row, stored, scope, incoming);
}

const refusal = (row, incoming, decision, reason) => {
  const controlling =
    decision && !recordedNameAllowed({ speakerDecision: decision })
      ? decision
      : {
          ...decision,
          candidateSetStatus: "not_recorded",
          acousticEvaluation: "not_evaluated",
          decisionId: `refused:${decision?.decisionId || incoming.speakerDecision?.decisionId || row.id}:${reason}`,
          acceptedProfileId: null,
          acceptedIdentity: null,
          rejectionReason: reason === "audio" ? "audio_changed" : "automatic_evidence_required",
          previousDecision: decision || null,
        };
  return {
    ...unknown(
      {
        ...incoming,
        audioSpan:
          row.id === incoming.id ? row.audioSpan || incoming.audioSpan : incoming.audioSpan,
        audioContentHash: row.id === incoming.id ? row.audioContentHash : undefined,
        uncertainty: row.uncertainty,
      },
      controlling
    ),
    speakerReviewRequired: row.speakerReviewRequired || incoming.speakerReviewRequired,
    speakerBoundary: {
      refusalReason: reason,
      proposedDecisionId: incoming.speakerDecision?.decisionId ?? null,
      controllingDecisionId: controlling.decisionId,
    },
  };
};

// Main and renderer use this same boundary. `restorationRowIds` is the action's
// affected set, never the full transcript returned alongside an action.
export function resolveAutomaticSpeaker(
  row,
  storedDecision,
  scope,
  incoming,
  { restorationRowIds = [], requireStoredAttribution = false } = {}
) {
  const restoring = restorationRowIds.includes(row.id);
  if (humanProtected(row) && !restoring) {
    return {
      ...copyAttribution(incoming, row),
      speaker: row.speaker,
      ...(row.speakerReviewRequired || incoming.speakerReviewRequired
        ? { speakerReviewRequired: false }
        : {}),
    };
  }
  if (humanProtected(incoming))
    return incoming.speakerReviewRequired ? { ...incoming, speakerReviewRequired: false } : incoming;
  if (requireStoredAttribution && !storedDecision && incoming.speakerDecision)
    return refusal(row, incoming, storedDecision, "row_binding");
  let next = incoming;
  if (row.id === incoming.id && storedDecision) {
    const span = incoming.audioSpan || row.audioSpan;
    const sameAudio = (!span && !row.audioSpan) || sameSpan(span, row.audioSpan);
    next = {
      ...incoming,
      audioSpan: span,
      audioContentHash: incoming.audioContentHash ?? (sameAudio ? row.audioContentHash : undefined),
    };
  }
  const changedMedia =
    ((row.audioSpan || next.audioSpan) && !sameSpan(row.audioSpan, next.audioSpan)) ||
    (row.audioContentHash ?? null) !== (next.audioContentHash ?? null);
  // Missing context may preserve an existing attribution, but cannot install a
  // changed automatic identity. Installers must obtain their note first.
  if (
    !scope &&
    (next.speakerName !== row.speakerName ||
      next.suggestedName !== row.suggestedName ||
      next.speakerDecision?.decisionId !== storedDecision?.decisionId ||
      (changedMedia && (storedDecision || row.speakerName || next.speakerName)))
  )
    return refusal(row, next, storedDecision, "scope_missing");
  const inherited = storedDecision && !recordedNameAllowed({ speakerDecision: storedDecision });
  if (storedDecision && !recordedNameAllowed(next) && changedMedia)
    return refusal(row, next, storedDecision, "audio");

  const audioChanged = row.audioSpan && next.audioSpan && !sameSpan(row.audioSpan, next.audioSpan);
  const claimedEvaluation =
    next.speakerDecision?.evaluation &&
    (next.speakerDecision.decisionId !== storedDecision?.decisionId || audioChanged);
  if (
    (inherited && recordedNameAllowed(next)) ||
    claimedEvaluation ||
    (changedMedia &&
      (row.audioContentHash || storedDecision?.evaluation) &&
      recordedNameAllowed(next))
  ) {
    const reason = evaluationRefusal(row, storedDecision, scope, next);
    if (reason) return refusal(row, next, storedDecision, reason);
  }
  // Unknown-origin names under a restricted roster have no acoustic evidence.
  const rosterScope =
    scope && ("participants" in scope || "id" in scope)
      ? preparedRosters.get(scope) || resolveSpeakerRoster(scope, null)
      : scope;
  const restricted = rosterScope && !rosterScope.unrestricted;
  if (
    !next.speakerDecision &&
    restricted &&
    (next.speakerName ||
      next.suggestedName ||
      next.speakerAssignment ||
      scope?.speaker_mapping_labels?.[next.speaker] ||
      (typeof next.speaker === "string" &&
        next.speaker !== "you" &&
        !next.speaker.startsWith("speaker_")))
  ) {
    return {
      ...unknown(next, {
        candidateSetStatus: "not_recorded",
        acousticEvaluation: "not_evaluated",
        decisionId: `legacy:${next.id}`,
        noteId: scope.noteId ?? scope.id,
        source: scope.source ?? "note",
        rawRoster: scope.rawRoster ?? scope.participants,
        rosterRevision: scope.rosterRevision ?? scope.speaker_roster_revision ?? 0,
        revision: rosterScope.revision,
        eligibleProfileIds: [],
        acceptedProfileId: null,
        rejectionReason: "legacy_not_evaluated",
      }),
      speakerReviewRequired: true,
    };
  }
  // Context-free normalization cannot decide a historical row's note scope.
  // Preserve unchanged undecided attribution until contextual installation;
  // restricted rosters were vetoed above. Proposals and machine imports still
  // validate below.
  if (
    (!scope || rosterScope?.unrestricted) &&
    !storedDecision &&
    !next.speakerDecision &&
    !row.speakerAssignment &&
    !next.speakerAssignment &&
    !changedMedia &&
    row.id === next.id &&
    row.speaker === next.speaker &&
    row.speakerName === next.speakerName &&
    row.speakerIsPlaceholder === next.speakerIsPlaceholder &&
    row.speakerStatus === next.speakerStatus &&
    row.suggestedName === next.suggestedName &&
    row.suggestedProfileId === next.suggestedProfileId
  )
    return next;
  const evidence = next.speakerDecision;
  if (evidence && !currentSpeakerDecision(evidence, scope)) {
    if (inherited) return refusal(row, incoming, storedDecision, "revision");
    next = unknown(
      {
        ...next,
        speakerBoundary: {
          refusalReason: "revision",
          proposedDecisionId: evidence.decisionId,
          controllingDecisionId: evidence.decisionId,
        },
      },
      {
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
      }
    );
  }
  if (!recordedNameAllowed(next)) {
    if (
      inherited &&
      next.speakerDecision?.decisionId === storedDecision.decisionId &&
      !next.speakerName &&
      !next.suggestedName
    )
      return unknown(next, storedDecision);
    return inherited
      ? refusal(
          row,
          next,
          storedDecision,
          !currentSpeakerDecision(incoming.speakerDecision, scope)
            ? "revision"
            : "proposal_rejected"
        )
      : unknown(next, next.speakerDecision);
  }
  if (
    next.overlap ||
    [
      "too_short",
      "close_match",
      "not_sure",
      "overlapping_speech",
      "possible_mixed_speakers",
    ].includes(next.uncertainty?.reason)
  ) {
    if (inherited) return refusal(row, next, storedDecision, "audio");
    return unknown(
      {
        ...next,
        speakerBoundary: {
          refusalReason: "audio",
          proposedDecisionId: next.speakerDecision?.decisionId,
          controllingDecisionId: next.speakerDecision?.decisionId,
        },
      },
      next.speakerDecision
        ? {
            ...next.speakerDecision,
            acceptedProfileId: null,
            acceptedIdentity: null,
            rejectionReason: "unsafe_span",
          }
        : undefined
    );
  }
  if (
    next.speakerDecision &&
    scope?.eligibleProfileIds &&
    !eligible(scope, next.speakerDecision.acceptedProfileId)
  ) {
    if (inherited) return refusal(row, next, storedDecision, "profile");
    return unknown(
      {
        ...next,
        speakerBoundary: {
          refusalReason: "profile",
          proposedDecisionId: next.speakerDecision.decisionId,
          controllingDecisionId: next.speakerDecision.decisionId,
        },
      },
      {
        ...next.speakerDecision,
        acceptedProfileId: null,
        acceptedIdentity: null,
        rejectionReason: "outside_roster",
      }
    );
  }
  if (inherited || claimedEvaluation) {
    const reason = evaluationRefusal(row, storedDecision, scope, next, true);
    if (reason) return refusal(row, next, storedDecision, reason);
    next = {
      ...next,
      speakerDecision: {
        ...evaluations.get(next.speakerDecision.evaluation).evaluatedDecision,
        evaluation: next.speakerDecision.evaluation,
      },
      speakerBoundary: {
        refusalReason: null,
        controllingDecisionId: next.speakerDecision.decisionId,
      },
      speakerReviewRequired: false,
    };
  }
  if (
    storedDecision &&
    next.speakerDecision?.decisionId === storedDecision.decisionId &&
    !claimedEvaluation
  )
    return { ...next, speakerDecision: storedDecision };
  return next;
}
