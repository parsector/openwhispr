import type { Commitment } from "../../types/electron";

export function sourceChipsByIndex(rows: Commitment[]): Map<number, Commitment[]> {
  const byIndex = new Map<number, Commitment[]>();
  for (const row of rows) {
    if (row.quote_segment_index == null || row.status === "completed" || row.status === "rejected") continue;
    const current = byIndex.get(row.quote_segment_index) || [];
    current.push(row);
    byIndex.set(row.quote_segment_index, current);
  }
  return byIndex;
}
