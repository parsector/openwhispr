import type { TranscriptSegment } from "../stores/meetingRecordingStore";
import { normalizeTranscriptSegments } from "./transcriptSpeakerState";
import logger from "./logger";
import { migrateTranscriptDocument } from "../helpers/transcriptDocument";

export function parseTranscriptSegmentsWithMigration(raw: string, noteId?: string | number): {
  segments: TranscriptSegment[]; migrated: boolean; quarantinedCorrections: number;
} {
  if (!raw.trim().startsWith("[") && !raw.trim().startsWith("{"))
    return { segments: [], migrated: false, quarantinedCorrections: 0 };
  try {
    const document = migrateTranscriptDocument(raw, noteId);
    return {
      segments: normalizeTranscriptSegments(document.rows.filter((row: { deleted?: boolean }) => !row.deleted) as TranscriptSegment[], document.unknownNumberHighWater),
      migrated: document.migrated,
      quarantinedCorrections: document.quarantinedCorrections,
    };
  } catch (e) {
    logger.warn("Failed to parse transcript segments", e);
    return { segments: [], migrated: false, quarantinedCorrections: 0 };
  }
}

export function parseTranscriptSegments(raw: string, noteId?: string | number): TranscriptSegment[] {
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
export function parseSeedSegments(raw: string | null | undefined, noteId?: string | number): TranscriptSegment[] {
  const text = raw?.trim();
  if (!text) return [];
  if (isJsonArray(text) || isTranscriptDocument(text)) return parseTranscriptSegments(text, noteId);
  return [{ id: crypto.randomUUID(), text, source: "system" }];
}
