import type { TranscriptSegment } from "../stores/meetingRecordingStore";
import type { TranscriptCorrection } from "./transcriptCorrections";

type LoggedAction = { id: string; kind: string; sequence: number; unavailableReason?: string;
  event?: { timestamp?: string; actor?: "user" | "machine"; initialAttribution?: boolean;
    afterFinalAnalysis?: boolean;
    affectedRowIds?: string[]; rowIds?: string[]; snapshots?: Record<string, {
      previous: TranscriptCorrection["previous"]; next: TranscriptCorrection["next"] }> } };

export function projectSpeakerActions(rows: TranscriptSegment[], rawLog?: string | null): TranscriptSegment[] {
  if (!rawLog) return rows.map(({ corrections, ...row }) => row);
  let actions: LoggedAction[];
  try { actions = JSON.parse(rawLog).actions; }
  catch { return rows.map(({ corrections, ...row }) => row); }
  if (!Array.isArray(actions)) return rows.map(({ corrections, ...row }) => row);
  const newest = [...actions].reverse().find(action => !action.unavailableReason);
  const byRow = new Map<string, TranscriptCorrection[]>();
  for (const action of actions) {
    if (!action.event || !["correction", "split", "reconsideration"].includes(action.kind)) continue;
    for (const rowId of action.event.affectedRowIds || action.event.rowIds || []) {
      const history = byRow.get(rowId) || [];
      history.push({ id: action.id, rowId, scope: "row", actor: action.event.actor || "user",
        timestamp: action.event.timestamp || "", sequence: action.sequence,
        kind: action.kind as TranscriptCorrection["kind"],
        previous: action.event.snapshots?.[rowId]?.previous || {},
        next: action.event.snapshots?.[rowId]?.next || {},
        undoAvailable: newest?.id === action.id,
        initialAttribution: !!action.event.initialAttribution,
        afterFinalAnalysis: !!action.event.afterFinalAnalysis } as TranscriptCorrection);
      byRow.set(rowId, history);
    }
  }
  return rows.map(({ corrections: _legacy, ...row }) => {
    const history = byRow.get(row.id) || [];
    const changed = history.some(item => item.afterFinalAnalysis && item.actor === "user");
    return { ...row, corrections: history, changedAfterFinal: row.changedAfterFinal || changed };
  });
}
