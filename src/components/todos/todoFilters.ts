import type { Commitment } from "../../types/electron";
import { matchesBriefPerson } from "./preMeetingBriefModel";

export type TodoFilter = { kind: "note" | "person"; value: string; email?: string | null } | null;

export function filterTodos(rows: Commitment[], filter: TodoFilter): Commitment[] {
  if (!filter) return rows;
  if (filter.kind === "note") return rows.filter((row) => row.source_note_id === filter.value);
  return rows.filter((row) =>
    matchesBriefPerson(row.person, { displayName: filter.value, email: filter.email })
  );
}
