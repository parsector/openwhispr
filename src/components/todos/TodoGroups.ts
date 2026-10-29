import type { Commitment } from "../../types/electron";

export type TodoGroup = "overdue" | "today" | "upcoming" | "noDate" | "waiting";
export const GROUP_ORDER: TodoGroup[] = ["overdue", "today", "upcoming", "noDate", "waiting"];

export function localDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function groupFor(row: Commitment, now = new Date()): TodoGroup {
  if (row.direction === "waiting") return "waiting";
  if (!row.due_date) return "noDate";
  const today = localDate(now);
  if (row.due_date < today && row.status === "open") return "overdue";
  if (row.due_date <= today) return "today";
  return "upcoming";
}

export function groupTodos(rows: Commitment[], now = new Date()): Array<{ key: TodoGroup; rows: Commitment[] }> {
  return GROUP_ORDER.map((key) => ({ key, rows: rows.filter((row) => groupFor(row, now) === key) }))
    .filter((group) => group.rows.length)
    .map((group) => ({ ...group, rows: group.rows.sort((a, b) =>
      (a.due_date || "9999").localeCompare(b.due_date || "9999") || a.created_at.localeCompare(b.created_at)) }));
}
