import {
  prepareAutomaticSpeakerScope,
  resolveAutomaticSpeaker,
} from "../helpers/automaticSpeakerAttribution";
import { humanProtected, recordedNameAllowed } from "../helpers/speakerRosterPolicy";
import type { TranscriptSegment } from "../stores/meetingRecordingStore";
import { allocateUnknownNumbers, writeTranscriptDocument } from "../helpers/transcriptDocument";

export type TranscriptSpeakerStatus = "provisional" | "confirmed" | "suggested" | "locked";
export type TranscriptSpeakerLockSource = "user" | "diarization" | "suggestion";

const SPEAKER_STATE_FIELDS = [
  "speaker",
  "speakerName",
  "speakerIsPlaceholder",
  "suggestedName",
  "suggestedProfileId",
  "speakerStatus",
  "speakerLocked",
  "speakerLockSource",
  "machineReason",
  "speakerDecision",
] as const;

type SpeakerStateField = (typeof SPEAKER_STATE_FIELDS)[number];

const normalizeText = (text: string) => text.trim().replace(/\s+/g, " ");

const getSegmentMatchKey = (segment: TranscriptSegment) =>
  [segment.source, segment.timestamp ?? "", normalizeText(segment.text)].join("|");

const canonicalizeTranscriptSpeakerStatus = (
  status?: string,
  speakerLocked?: boolean,
  speakerLockSource?: TranscriptSpeakerLockSource
): TranscriptSpeakerStatus | undefined => {
  if (speakerLocked || speakerLockSource === "user") {
    return "locked";
  }

  switch (status) {
    case "provisional":
    case "confirmed":
    case "suggested":
    case "locked":
      return status;
    case "suggested_profile":
      return "suggested";
    case "user_locked":
      return "locked";
    case "uncertain_overlap":
      return "provisional";
    default:
      return undefined;
  }
};

const pickSpeakerStatus = (segment: TranscriptSegment): TranscriptSpeakerStatus | undefined => {
  const normalizedStatus = canonicalizeTranscriptSpeakerStatus(
    segment.speakerStatus,
    segment.speakerLocked,
    segment.speakerLockSource
  );
  if (normalizedStatus) return normalizedStatus;
  if (segment.suggestedName && !segment.speakerName) return "suggested";
  if (segment.source === "system" && segment.speakerIsPlaceholder) return "provisional";
  if (segment.speaker && segment.speaker !== "you") return "confirmed";
  return undefined;
};

export const isTranscriptSpeakerLocked = (segment: TranscriptSegment) => humanProtected(segment);

export const normalizeTranscriptSegment = (segment: TranscriptSegment): TranscriptSegment => {
  segment = resolveAutomaticSpeaker(segment, segment.speakerDecision, null, segment);
  if (!recordedNameAllowed(segment))
    segment = {
      ...segment,
      speakerName: undefined,
      suggestedName: undefined,
      suggestedProfileId: undefined,
      speakerIsPlaceholder: true,
    };
  const speakerStatus = pickSpeakerStatus(segment);
  const speakerLocked =
    !!segment.speakerLocked || segment.speakerLockSource === "user" || speakerStatus === "locked";
  return {
    ...segment,
    speakerStatus,
    speakerLocked,
    speakerLockSource: speakerLocked
      ? (segment.speakerLockSource ?? "user")
      : segment.speakerLockSource,
  };
};

export const normalizeTranscriptSegments = (segments: TranscriptSegment[], noteHighWater = 0) => {
  return (allocateUnknownNumbers(segments, noteHighWater) as TranscriptSegment[]).map(
    normalizeTranscriptSegment
  );
};

export const applyTranscriptSpeakerPatch = (
  segment: TranscriptSegment,
  patch: Partial<Pick<TranscriptSegment, SpeakerStateField>>
) =>
  normalizeTranscriptSegment(
    resolveAutomaticSpeaker(segment, segment.speakerDecision, null, { ...segment, ...patch })
  );

export const lockTranscriptSpeaker = (
  segment: TranscriptSegment,
  patch: Partial<Pick<TranscriptSegment, SpeakerStateField>> = {}
) =>
  normalizeTranscriptSegment({
    ...segment,
    ...patch,
    speakerLocked: true,
    speakerStatus: "locked",
    speakerLockSource: "user",
  });

const mergeSpeakerFields = (
  existing: TranscriptSegment,
  incoming: TranscriptSegment,
  scope: unknown
) => {
  const merged = {
    ...incoming,
    ...(existing.recorderName ? { recorderName: existing.recorderName } : {}),
  } as TranscriptSegment;
  const sameText = normalizeText(existing.text) === normalizeText(incoming.text);
  if (sameText && !merged.wordTimings && existing.wordTimings)
    merged.wordTimings = existing.wordTimings;
  if (sameText && !merged.audioSpan && existing.audioSpan && merged.wordTimings)
    merged.audioSpan = existing.audioSpan;
  const existingFields = existing as Record<SpeakerStateField, unknown>;
  const mergedFields = merged as Record<SpeakerStateField, unknown>;
  const preserveMachineName =
    existing.machineReason === "approved_voice" &&
    existing.speaker === incoming.speaker &&
    !isTranscriptSpeakerLocked(existing) &&
    !incoming.speakerDecision?.rejectionReason;

  for (const field of SPEAKER_STATE_FIELDS) {
    if (mergedFields[field] === undefined && existingFields[field] !== undefined) {
      if (
        (field === "speakerName" || field === "speakerStatus") &&
        incoming.speakerIsPlaceholder &&
        !isTranscriptSpeakerLocked(existing) &&
        !preserveMachineName
      )
        continue;
      mergedFields[field] = existingFields[field];
    }
  }

  if (
    incoming.speakerIsPlaceholder &&
    !isTranscriptSpeakerLocked(existing) &&
    !preserveMachineName
  ) {
    merged.speakerName = undefined;
    if (incoming.speakerStatus !== "confirmed") merged.speakerStatus = "provisional";
  }

  if (preserveMachineName && incoming.speakerIsPlaceholder) {
    merged.speakerIsPlaceholder = false;
    merged.speakerStatus = "confirmed";
  }

  if (isTranscriptSpeakerLocked(existing)) {
    // A user decision is authoritative, including an explicit Unknown and its cluster.
    for (const field of SPEAKER_STATE_FIELDS) {
      mergedFields[field] = existingFields[field];
    }
    merged.speakerIsPlaceholder = existing.speakerIsPlaceholder;
    merged.uncertainty = undefined;
    merged.changedAfterFinal = existing.changedAfterFinal;
    merged.finalRevision = existing.finalRevision;
    if (
      incoming.parentRowId === existing.id &&
      incoming.splitStartWord === 0 &&
      incoming.text !== existing.text
    ) {
      merged.text = existing.text;
      merged.wordTimings = existing.wordTimings;
      merged.audioSpan = existing.audioSpan;
      merged.parentRowId = existing.parentRowId;
      merged.splitStartWord = existing.splitStartWord;
    }
  }

  return normalizeTranscriptSegment(
    resolveAutomaticSpeaker(existing, existing.speakerDecision, scope, merged)
  );
};

export const mergeTranscriptSegments = (
  existingSegments: TranscriptSegment[],
  incomingSegments: TranscriptSegment[],
  noteHighWater = 0,
  preserveMatchedNumbers = false,
  scope: unknown = null
) => {
  if (incomingSegments.length === 0) {
    return normalizeTranscriptSegments(existingSegments, noteHighWater);
  }
  if (existingSegments.length === 0) {
    return normalizeTranscriptSegments(
      incomingSegments.map((segment) => ({ ...segment, id: segment.id || crypto.randomUUID() })),
      noteHighWater
    );
  }

  scope = prepareAutomaticSpeakerScope(scope);
  const existingById = new Map<string, number>();
  const existingByKey = new Map<string, number[]>();

  existingSegments.forEach((segment, index) => {
    if (segment.id) existingById.set(segment.id, index);
    const key = getSegmentMatchKey(segment);
    const bucket = existingByKey.get(key);
    if (bucket) bucket.push(index);
    else existingByKey.set(key, [index]);
  });

  const usedIndexes = new Set<number>();
  const reservedExactIndexes = new Set(
    incomingSegments.flatMap((segment) => {
      const index = segment.id ? existingById.get(segment.id) : undefined;
      return index === undefined ? [] : [index];
    })
  );
  const enrichedByIndex = new Map<number, TranscriptSegment>();
  const unmatchedIncoming: TranscriptSegment[] = [];

  incomingSegments.forEach((segment, index) => {
    const parent =
      segment.parentRowId && existingSegments.find((row) => row.id === segment.parentRowId);
    if (
      segment.parentRowId &&
      segment.parentRowId !== segment.id &&
      parent &&
      isTranscriptSpeakerLocked(parent)
    )
      return;
    if (parent) segment = resolveAutomaticSpeaker(parent, parent.speakerDecision, scope, segment);
    const findUnused = (candidates?: number[]) =>
      candidates?.find((candidateIndex) => !usedIndexes.has(candidateIndex));

    let matchIndex = segment.id ? existingById.get(segment.id) : undefined;
    if (matchIndex !== undefined && usedIndexes.has(matchIndex)) matchIndex = undefined;

    const newSplitChild =
      !!segment.parentRowId && segment.parentRowId !== segment.id && !existingById.has(segment.id);
    if (matchIndex === undefined && !newSplitChild) {
      matchIndex = findUnused(
        existingByKey
          .get(getSegmentMatchKey(segment))
          ?.filter((candidateIndex) => !reservedExactIndexes.has(candidateIndex))
      );
    }

    if (matchIndex === undefined && !newSplitChild) {
      const fallbackIndex = existingSegments.findIndex(
        (candidate, existingIndex) =>
          !usedIndexes.has(existingIndex) &&
          !reservedExactIndexes.has(existingIndex) &&
          candidate.source === segment.source &&
          candidate.text === segment.text
      );
      if (fallbackIndex >= 0) matchIndex = fallbackIndex;
    }

    if (matchIndex === undefined && !newSplitChild && Number.isFinite(segment.timestamp)) {
      const candidates = existingSegments
        .map((row, existingIndex) => ({ row, existingIndex }))
        .filter(
          ({ row, existingIndex }) =>
            !usedIndexes.has(existingIndex) &&
            !reservedExactIndexes.has(existingIndex) &&
            row.source === segment.source &&
            Number.isFinite(row.timestamp) &&
            Math.abs((row.timestamp as number) - (segment.timestamp as number)) <= 0.5
        );
      // A time-only match is safe only when there is one possible predecessor.
      if (candidates.length === 1) matchIndex = candidates[0].existingIndex;
    }

    if (matchIndex !== undefined) {
      const existing = existingSegments[matchIndex];
      // A text/time match is useful for display reconciliation, but it is not
      // lineage. Keep the corrected row and show a new transcription separately.
      if (
        existing.id !== segment.id &&
        (isTranscriptSpeakerLocked(existing) || isTranscriptSpeakerLocked(segment))
      ) {
        unmatchedIncoming.push(
          normalizeTranscriptSegment({ ...segment, id: segment.id || crypto.randomUUID() })
        );
        return;
      }
      if (existing.id !== segment.id && existing.speakerDecision) {
        // A new automatic transcription may replace this display row, but
        // fuzzy text/time correspondence conveys no attribution or veto.
        usedIndexes.add(matchIndex);
        enrichedByIndex.set(matchIndex, normalizeTranscriptSegment(segment));
        return;
      }
      usedIndexes.add(matchIndex);
      enrichedByIndex.set(
        matchIndex,
        mergeSpeakerFields(
          existing,
          {
            ...segment,
            id: existingSegments[matchIndex].id,
            unknownNumber:
              preserveMatchedNumbers || segment.speaker === existingSegments[matchIndex].speaker
                ? existingSegments[matchIndex].unknownNumber
                : undefined,
            unknownNumberHighWater: existingSegments[matchIndex].unknownNumberHighWater,
          },
          scope
        )
      );
    } else {
      unmatchedIncoming.push(
        normalizeTranscriptSegment({ ...segment, id: segment.id || crypto.randomUUID() })
      );
    }
  });

  const preserved = existingSegments.map(
    (segment, index) => enrichedByIndex.get(index) ?? normalizeTranscriptSegment(segment)
  );

  return normalizeTranscriptSegments([...preserved, ...unmatchedIncoming], noteHighWater);
};

// Install an action response only within the committed action's affected set.
// Rows that arrived while IPC was pending keep their own evidence and locks.
export const restoreTranscriptSpeakerRows = (
  existing: TranscriptSegment[],
  committed: TranscriptSegment[],
  scope: unknown,
  affectedRowIds: string[]
): TranscriptSegment[] => {
  const affected = new Set(affectedRowIds);
  const byId = new Map(existing.map((row) => [row.id, row]));
  const incoming = new Map(committed.map((row) => [row.id, row]));
  const rows = existing.map((row) =>
    affected.has(row.id) && incoming.has(row.id)
      ? normalizeTranscriptSegment(
          resolveAutomaticSpeaker(row, row.speakerDecision, scope, incoming.get(row.id), {
            restorationRowIds: affectedRowIds,
          })
        )
      : row
  );
  return [
    ...rows,
    ...committed
      .filter((row) => !byId.has(row.id))
      .map((row) => normalizeTranscriptSegment(resolveAutomaticSpeaker(row, null, scope, row))),
  ];
};

export const serializeTranscriptSegments = (segments: TranscriptSegment[], noteHighWater = 0) => {
  const normalized = normalizeTranscriptSegments(segments, noteHighWater);
  return writeTranscriptDocument(
    normalized.map((segment) => ({
      id: segment.id || crypto.randomUUID(),
      audioSpan: segment.audioSpan,
      audioContentHash: segment.audioContentHash,
      wordTimings: segment.wordTimings,
      parentRowId: segment.parentRowId,
      splitStartWord: segment.splitStartWord,
      changedAfterFinal: segment.changedAfterFinal,
      finalAnalysisCompleted: segment.finalAnalysisCompleted,
      finalRevision: segment.finalRevision,
      unknownNumber: segment.unknownNumber,
      unknownNumberHighWater: segment.unknownNumberHighWater,
      uncertainty: segment.uncertainty,
      diarizationRunId: segment.diarizationRunId,
      correctionRevision: segment.correctionRevision,
      speakerAssessmentAvailable: segment.speakerAssessmentAvailable,
      importedUnlabeled: segment.importedUnlabeled,
      quarantinedCorrections: segment.quarantinedCorrections,
      text: segment.text,
      source: segment.source,
      timestamp: segment.timestamp,
      speechStart: segment.speechStart,
      speechEnd: segment.speechEnd,
      recordingId: segment.recordingId,
      recordingOrigin: segment.recordingOrigin,
      timebase: segment.timebase,
      speaker: segment.speaker,
      speakerName: segment.speakerName,
      recorderName: segment.recorderName,
      speakerIsPlaceholder: segment.speakerIsPlaceholder,
      suggestedName: segment.suggestedName,
      suggestedProfileId: segment.suggestedProfileId,
      speakerStatus: segment.speakerStatus,
      speakerLocked: segment.speakerLocked,
      speakerLockSource: segment.speakerLockSource,
      machineReason: segment.machineReason,
      speakerDecision: segment.speakerDecision,
      speakerReviewRequired: segment.speakerReviewRequired,
      speakerBoundary: segment.speakerBoundary,
      speakerAssignment: segment.speakerAssignment,
    })),
    Math.max(noteHighWater, ...normalized.map((segment) => segment.unknownNumberHighWater || 0), 0)
  );
};

// A speaker mapping renames a whole diarization cluster; a locked segment is the
// user correcting one stretch of it. The correction has to outrank the cluster,
// or reassigning part of a mis-split block appears to do nothing (#1533). This
// mirrors the precedence the exporter already applies in transcriptFormatter.js.
export const resolveMappedSpeakerName = (
  segment: TranscriptSegment,
  speakerMappings?: Record<string, string>
): string | undefined => {
  if (!recordedNameAllowed(segment)) return undefined;
  if (isTranscriptSpeakerLocked(segment) || segment.diarizationRunId || segment.speakerDecision)
    return segment.speakerIsPlaceholder ? undefined : segment.speakerName;
  const mapped =
    segment.speaker && !(segment.speaker === "you" && segment.recorderName)
      ? speakerMappings?.[segment.speaker]
      : undefined;
  if (mapped) return mapped;
  if (segment.speakerIsPlaceholder) return undefined;
  return (
    segment.speakerName ||
    (typeof segment.speaker === "string" &&
    segment.speaker !== "you" &&
    !segment.speaker.startsWith("speaker_")
      ? segment.speaker
      : undefined)
  );
};

export const resolveSegmentSpeakerName = (
  segment: TranscriptSegment,
  speakerMappings?: Record<string, string>
): string | undefined =>
  recordedNameAllowed(segment)
    ? resolveMappedSpeakerName(segment, speakerMappings) ||
      (segment.speakerIsPlaceholder ? undefined : segment.speakerName)
    : undefined;

// Naming a speaker "You" is how the user marks their own voice. The name is
// stored in the UI language it was saved in, so English "You" counts in every
// language alongside the current one.
export const isYouSpeakerName = (name: string, youLabel: string): boolean => {
  const normalized = name.trim().toLowerCase();
  return normalized === "you" || normalized === youLabel.toLowerCase();
};

// A name decides the side when one exists. An unnamed microphone cluster uses
// the note owner's visual lane, without identifying its speaker as the owner.
export const isSelfSideSegment = (
  segment: TranscriptSegment,
  speakerMappings: Record<string, string> | undefined,
  youLabel: string
): boolean => {
  const name = resolveSegmentSpeakerName(segment, speakerMappings);
  if (name) {
    // Automatic remote matches may be wrong; only a user lock moves them
    // to the note owner's side. Mappings also hold automatic matches.
    const autoNamedRemote = segment.source === "system" && !isTranscriptSpeakerLocked(segment);
    return !autoNamedRemote && isYouSpeakerName(name, youLabel);
  }
  if (segment.speaker === "you") return !isTranscriptSpeakerLocked(segment);
  return segment.source === "mic";
};
