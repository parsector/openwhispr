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

export const isTranscriptSpeakerLocked = (segment: TranscriptSegment) =>
  !!segment.speakerLocked ||
  segment.speakerLockSource === "user" ||
  canonicalizeTranscriptSpeakerStatus(segment.speakerStatus) === "locked";

export const normalizeTranscriptSegment = (segment: TranscriptSegment): TranscriptSegment => {
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
  return (allocateUnknownNumbers(segments, noteHighWater) as TranscriptSegment[])
    .map(normalizeTranscriptSegment);
};

export const applyTranscriptSpeakerPatch = (
  segment: TranscriptSegment,
  patch: Partial<Pick<TranscriptSegment, SpeakerStateField>>
) => normalizeTranscriptSegment({ ...segment, ...patch });

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

const mergeSpeakerFields = (existing: TranscriptSegment, incoming: TranscriptSegment) => {
  const merged = { ...incoming } as TranscriptSegment;
  const existingFields = existing as Record<SpeakerStateField, unknown>;
  const mergedFields = merged as Record<SpeakerStateField, unknown>;

  for (const field of SPEAKER_STATE_FIELDS) {
    if (mergedFields[field] === undefined && existingFields[field] !== undefined) {
      if ((field === "speakerName" || field === "speakerStatus") &&
        incoming.speakerIsPlaceholder && !isTranscriptSpeakerLocked(existing)) continue;
      mergedFields[field] = existingFields[field];
    }
  }

  if (incoming.speakerIsPlaceholder && !isTranscriptSpeakerLocked(existing)) {
    merged.speakerName = undefined;
    if (incoming.speakerStatus !== "confirmed") merged.speakerStatus = "provisional";
  }

  if (isTranscriptSpeakerLocked(existing)) {
    // Keep the user's name/lock but let diarization refine the speaker cluster, so one
    // locked label can't freeze a bucket diarization splits into multiple speakers.
    for (const field of SPEAKER_STATE_FIELDS) {
      if (field === "speaker" || field === "speakerIsPlaceholder") continue;
      mergedFields[field] = existingFields[field];
    }
    merged.speakerIsPlaceholder = existing.speakerIsPlaceholder;
    merged.uncertainty = undefined;
  }

  return normalizeTranscriptSegment(merged);
};

export const mergeTranscriptSegments = (
  existingSegments: TranscriptSegment[],
  incomingSegments: TranscriptSegment[],
  noteHighWater = 0,
  preserveMatchedNumbers = false
) => {
  if (incomingSegments.length === 0) {
    return normalizeTranscriptSegments(existingSegments, noteHighWater);
  }
  if (existingSegments.length === 0) {
    return normalizeTranscriptSegments(incomingSegments.map((segment) =>
      ({ ...segment, id: segment.id || crypto.randomUUID() })
    ), noteHighWater);
  }

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
  const enrichedByIndex = new Map<number, TranscriptSegment>();
  const unmatchedIncoming: TranscriptSegment[] = [];

  incomingSegments.forEach((segment, index) => {
    const findUnused = (candidates?: number[]) =>
      candidates?.find((candidateIndex) => !usedIndexes.has(candidateIndex));

    let matchIndex = segment.id ? existingById.get(segment.id) : undefined;
    if (matchIndex !== undefined && usedIndexes.has(matchIndex)) matchIndex = undefined;

    if (matchIndex === undefined) {
      matchIndex = findUnused(existingByKey.get(getSegmentMatchKey(segment)));
    }

    if (matchIndex === undefined) {
      const fallbackIndex = existingSegments.findIndex(
        (candidate, existingIndex) =>
          !usedIndexes.has(existingIndex) &&
          candidate.source === segment.source &&
          candidate.text === segment.text
      );
      if (fallbackIndex >= 0) matchIndex = fallbackIndex;
    }

    if (matchIndex === undefined && Number.isFinite(segment.timestamp)) {
      const candidates = existingSegments
        .map((row, existingIndex) => ({ row, existingIndex }))
        .filter(({ row, existingIndex }) =>
          !usedIndexes.has(existingIndex) && row.source === segment.source &&
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
      if (existing.id !== segment.id && (
        isTranscriptSpeakerLocked(existing) || existing.corrections?.length ||
        isTranscriptSpeakerLocked(segment) || segment.corrections?.length
      )) {
        unmatchedIncoming.push(normalizeTranscriptSegment({ ...segment, id: segment.id || crypto.randomUUID() }));
        return;
      }
      usedIndexes.add(matchIndex);
      enrichedByIndex.set(matchIndex, mergeSpeakerFields(existing, {
        ...segment,
        id: existingSegments[matchIndex].id,
        unknownNumber: (preserveMatchedNumbers || segment.speaker === existingSegments[matchIndex].speaker)
          ? existingSegments[matchIndex].unknownNumber : undefined,
        unknownNumberHighWater: existingSegments[matchIndex].unknownNumberHighWater,
        corrections: existingSegments[matchIndex].corrections,
      }));
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

export const serializeTranscriptSegments = (segments: TranscriptSegment[], noteHighWater = 0) => {
  const normalized = normalizeTranscriptSegments(segments, noteHighWater);
  return writeTranscriptDocument(
    normalized.map((segment) => ({
      id: segment.id || crypto.randomUUID(),
      unknownNumber: segment.unknownNumber,
      unknownNumberHighWater: segment.unknownNumberHighWater,
      uncertainty: segment.uncertainty,
      diarizationRunId: segment.diarizationRunId,
      correctionRevision: segment.correctionRevision,
      speakerAssessmentAvailable: segment.speakerAssessmentAvailable,
      importedUnlabeled: segment.importedUnlabeled,
      corrections: segment.corrections,
      quarantinedCorrections: segment.quarantinedCorrections,
      text: segment.text,
      source: segment.source,
      timestamp: segment.timestamp,
      speaker: segment.speaker,
      speakerName: segment.speakerName,
      speakerIsPlaceholder: segment.speakerIsPlaceholder,
      suggestedName: segment.suggestedName,
      suggestedProfileId: segment.suggestedProfileId,
      speakerStatus: segment.speakerStatus,
      speakerLocked: segment.speakerLocked,
      speakerLockSource: segment.speakerLockSource,
    })), Math.max(noteHighWater, ...normalized.map((segment) => segment.unknownNumberHighWater || 0), 0)
  );
};

// A speaker mapping renames a whole diarization cluster; a locked segment is the
// user correcting one stretch of it. The correction has to outrank the cluster,
// or reassigning part of a mis-split block appears to do nothing (#1533). This
// mirrors the precedence the exporter already applies in transcriptFormatter.js.
export const resolveSegmentSpeakerName = (
  segment: TranscriptSegment,
  speakerMappings?: Record<string, string>
): string | undefined => {
  if (isTranscriptSpeakerLocked(segment))
    return segment.speakerIsPlaceholder ? undefined : segment.speakerName;
  if (segment.diarizationRunId) return segment.speakerIsPlaceholder ? undefined : segment.speakerName;
  const mapped = segment.speaker ? speakerMappings?.[segment.speaker] : undefined;
  if (mapped) return mapped;
  if (segment.speakerIsPlaceholder) return undefined;
  return segment.speakerName || (typeof segment.speaker === "string" && segment.speaker !== "you" &&
    !segment.speaker.startsWith("speaker_") ? segment.speaker : undefined);
};

// Naming a speaker "You" is how the user marks their own voice. The name is
// stored in the UI language it was saved in, so English "You" counts in every
// language alongside the current one.
export const isYouSpeakerName = (name: string, youLabel: string): boolean => {
  const normalized = name.trim().toLowerCase();
  return normalized === "you" || normalized === youLabel.toLowerCase();
};

// Which side of the transcript a bubble sits on follows the name its chip shows,
// so a stretch the user reassigned moves with its new name. An in-person meeting
// is diarized on the mic without knowing which voice is the note taker, so its
// numbered clusters, the user's own included, sit with the other speakers until
// one is named "You". Mic channel alone never establishes ownership.
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
  if (
    segment.source === "mic" &&
    segment.suggestedName &&
    isYouSpeakerName(segment.suggestedName, youLabel)
  ) {
    return true;
  }
  if (segment.speaker === "you") return !isTranscriptSpeakerLocked(segment);
  if (segment.speaker) return false;
  return segment.source === "mic";
};
