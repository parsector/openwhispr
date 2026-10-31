import type { TranscriptSegment } from "../../src/stores/meetingRecordingStore";
import { lockTranscriptSpeaker } from "../../src/utils/transcriptSpeakerState";

export type CorrectionScope = "row" | "selected" | "cluster";
export interface SpeakerValue {
  speakerName?: string;
  speakerIsPlaceholder?: boolean;
  speakerStatus?: TranscriptSegment["speakerStatus"];
  speakerLocked?: boolean;
  speakerLockSource?: TranscriptSegment["speakerLockSource"];
  suggestedName?: string;
  suggestedProfileId?: number;
  uncertainty?: TranscriptSegment["uncertainty"];
  machineReason?: TranscriptSegment["machineReason"];
}
export interface TranscriptCorrection {
  id: string;
  noteId?: number;
  rowId: string;
  scope: CorrectionScope;
  previous: SpeakerValue;
  next: SpeakerValue;
  actor: "user" | "machine";
  timestamp: string;
  sequence?: number;
  undoAvailable?: boolean;
  initialAttribution?: boolean;
  diarizationRunId?: string;
  clusterId?: string;
  mappingChanged?: boolean;
  target?: { runId?: string; clusterId?: string } | { rowIds: string[] };
  affectedRowIds?: string[];
  mappingBefore?: { displayName: string; profileId: number | null } | null;
  mappingAfter?: { displayName: string | null; profileId: number | null } | null;
  snapshots?: Record<string, { previous: SpeakerValue; next: SpeakerValue }>;
}
const value = (row: TranscriptSegment): SpeakerValue => ({
  speakerName: row.speakerName,
  speakerIsPlaceholder: row.speakerIsPlaceholder,
  speakerStatus: row.speakerStatus,
  speakerLocked: row.speakerLocked,
  speakerLockSource: row.speakerLockSource,
  suggestedName: row.suggestedName,
  suggestedProfileId: row.suggestedProfileId,
  uncertainty: row.uncertainty,
  machineReason: row.machineReason,
});

export function correctTranscriptRows(
  rows: TranscriptSegment[], ids: Set<string>, scope: CorrectionScope,
  name: string | null, profileId?: number, noteId?: number,
  runId?: string, clusterId?: string
): TranscriptSegment[] {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const changed = rows.map((row) => {
    if (!ids.has(row.id) || (scope === "cluster" &&
      (row.diarizationRunId !== runId || row.speaker !== clusterId))) return row;
    const next = { ...lockTranscriptSpeaker(row, {
      speakerName: name || undefined,
      speakerIsPlaceholder: !name,
      suggestedName: undefined,
      suggestedProfileId: profileId,
    }), uncertainty: undefined };
    return { ...next, corrections: [...(row.corrections || []), {
      id, noteId, rowId: row.id, scope, previous: value(row), next: value(next),
      actor: "user" as const, timestamp, diarizationRunId: row.diarizationRunId,
      clusterId: scope === "cluster" ? row.speaker : undefined,
    }] };
  });
  return changed;
}

export function undoTranscriptCorrection(rows: TranscriptSegment[], correctionId: string): TranscriptSegment[] {
  return rows.map((row) => {
    const records = row.corrections || [];
    const record = records.find((item) => item.id === correctionId);
    if (!record) return row;
    if (records.at(-1)?.id !== correctionId) {
      const index = records.findIndex((item) => item.id === correctionId);
      const updated = records.map((item, current) => current === index + 1
        ? { ...item, previous: record.previous } : item);
      return { ...row, corrections: updated.filter((item) => item.id !== correctionId) };
    }
    const restored = { ...row };
    for (const field of Object.keys(value(row)) as Array<keyof SpeakerValue>) {
      delete restored[field];
    }
    Object.assign(restored, Object.fromEntries(Object.entries(record.previous).filter(([, val]) => val !== undefined)));
    const remaining = records.filter((item) => item.id !== correctionId);
    if (remaining.length) restored.corrections = remaining;
    else delete restored.corrections;
    return restored;
  });
}

export function latestCorrection(row: TranscriptSegment): TranscriptCorrection | undefined {
  return row.corrections?.at(-1);
}
