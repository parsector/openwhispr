import type { TranscriptSegment } from "../stores/meetingRecordingStore";
import { normalizeTranscriptSegments } from "./transcriptSpeakerState";
import logger from "./logger";
import { readTranscriptDocument } from "../helpers/transcriptDocument";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// A stable, note-scoped UUID for ids minted by older versions. No index enters
// the mapping, so removing or reordering a row cannot change another row's id.
function legacyUuid(noteId: number | undefined, oldId: string): string {
  const input = `${noteId ?? "unknown"}\0${oldId}`;
  const hash = (seed: number) => {
    let value = seed;
    for (let i = 0; i < input.length; i += 1) value = Math.imul(value ^ input.charCodeAt(i), 16777619);
    return (value >>> 0).toString(16).padStart(8, "0");
  };
  const hex = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35].map(hash).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function parseTranscriptSegmentsWithMigration(raw: string, noteId?: number): {
  segments: TranscriptSegment[]; migrated: boolean; droppedCorrections: number;
} {
  if (!raw.trim().startsWith("[") && !raw.trim().startsWith("{")) return { segments: [], migrated: false, droppedCorrections: 0 };
  try {
    const document = readTranscriptDocument(raw);
    const parsed = document.rows as Array<{
      id?: string;
      unknownNumber?: number;
      unknownNumberHighWater?: number;
      uncertainty?: TranscriptSegment["uncertainty"];
      diarizationRunId?: string;
      corrections?: TranscriptSegment["corrections"];
      text: string;
      source: "mic" | "system";
      timestamp?: number;
      speaker?: string;
      speakerName?: string;
      speakerIsPlaceholder?: boolean;
      suggestedName?: string;
      suggestedProfileId?: number;
      speakerStatus?: TranscriptSegment["speakerStatus"];
      speakerLocked?: TranscriptSegment["speakerLocked"];
      speakerLockSource?: TranscriptSegment["speakerLockSource"];
    }>;
    const oldIds = new Map<string, string>();
    const counts = new Map<string, number>();
    for (const s of parsed) if (s.id) counts.set(s.id, (counts.get(s.id) || 0) + 1);
    let migrated = false;
    let droppedCorrections = 0;
    const segments = normalizeTranscriptSegments(parsed.map((s) => {
        const uniqueOldId = s.id && counts.get(s.id) === 1 ? s.id : undefined;
        const id = uniqueOldId
          ? (UUID_RE.test(uniqueOldId) ? uniqueOldId : legacyUuid(noteId, uniqueOldId))
          : crypto.randomUUID();
        if (id !== s.id) migrated = true;
        if (uniqueOldId) oldIds.set(uniqueOldId, id);
        return {
          id,
          unknownNumber: s.unknownNumber,
          unknownNumberHighWater: s.unknownNumberHighWater,
          uncertainty: s.uncertainty,
          diarizationRunId: s.diarizationRunId,
          corrections: s.corrections,
          text: s.text,
          source: s.source,
          timestamp: s.timestamp,
          speaker: s.speaker,
          speakerName: s.speakerName,
          speakerIsPlaceholder: s.speakerIsPlaceholder,
          suggestedName: s.suggestedName,
          suggestedProfileId: s.suggestedProfileId,
          speakerStatus: s.speakerStatus,
          speakerLocked: s.speakerLocked,
          speakerLockSource: s.speakerLockSource,
        };
      }), document.unknownNumberHighWater);
    for (const row of segments) {
      if (!row.corrections) continue;
      row.corrections = row.corrections.flatMap((record) => {
        const rowId = oldIds.get(record.rowId);
        if (!rowId || rowId !== row.id) {
          droppedCorrections += 1;
          migrated = true;
          return [];
        }
        return [{ ...record, rowId, noteId: record.noteId ?? noteId }];
      });
    }
    if (droppedCorrections) logger.warn(`Dropped ${droppedCorrections} unresolved transcript corrections`, { noteId });
    return { segments, migrated, droppedCorrections };
  } catch (e) {
    logger.warn("Failed to parse transcript segments", e);
    return { segments: [], migrated: false, droppedCorrections: 0 };
  }
}

export function parseTranscriptSegments(raw: string, noteId?: number): TranscriptSegment[] {
  return parseTranscriptSegmentsWithMigration(raw, noteId).segments;
}

/**
 * The text of a transcript none of whose segments says who speaks (no speaker,
 * speaker name or source), joined with blank lines; null otherwise. Uploads
 * whose provider returned no speakers store their text this way, so note
 * actions run it as a plain transcript (#2666), not a meeting where every line
 * would be "Them". transcriptFormatter.js's `isSpeakerless` makes the same call
 * for exports.
 */
export function speakerlessTranscriptText(segments: TranscriptSegment[]): string | null {
  const speakerless =
    segments.length > 0 &&
    segments.every((segment) => !segment.source && !segment.speaker && !segment.speakerName);
  return speakerless ? segments.map((segment) => segment.text).join("\n\n") : null;
}

const isJsonArray = (raw: string): boolean => {
  try {
    return Array.isArray(JSON.parse(raw));
  } catch {
    return false;
  }
};
const isTranscriptDocument = (raw: string): boolean => {
  try { return Array.isArray(JSON.parse(raw)?.rows); } catch { return false; }
};

/**
 * Segments to seed a recording into a note with. Every save of that recording
 * writes its segments over the stored transcript, so a plain-text one (v1.6.0–
 * v1.6.5 meetings, or a recording with no segments) is carried as one segment.
 * It has no timestamp or speaker: live speaker identification skips it, new
 * finals sort after it, and export keeps rebasing on the new segments' times.
 */
export function parseSeedSegments(raw: string | null | undefined, noteId?: number): TranscriptSegment[] {
  const text = raw?.trim();
  if (!text) return [];
  if (isJsonArray(text) || isTranscriptDocument(text)) return parseTranscriptSegments(text, noteId);
  return [{ id: crypto.randomUUID(), text, source: "system" }];
}
