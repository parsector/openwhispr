import type { TranscriptSegment } from "../stores/meetingRecordingStore";

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
  unavailableReason?: string;
  initialAttribution?: boolean;
  afterFinalAnalysis?: boolean;
  kind?: "correction" | "split" | "reconsideration";
  diarizationRunId?: string;
  clusterId?: string;
  mappingChanged?: boolean;
  target?: { runId?: string; clusterId?: string } | { rowIds: string[] };
  affectedRowIds?: string[];
  mappingBefore?: { displayName: string; profileId: number | null } | null;
  mappingAfter?: { displayName: string | null; profileId: number | null } | null;
  snapshots?: Record<string, { previous: SpeakerValue; next: SpeakerValue }>;
}
export function latestCorrection(row: TranscriptSegment): TranscriptCorrection | undefined {
  return row.corrections?.at(-1);
}
