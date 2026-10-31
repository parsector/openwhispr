import type { Commitment } from "../../types/electron";

export interface BriefAttendee {
  displayName?: string | null;
  name?: string | null;
  email?: string | null;
  self?: boolean;
}
export interface BriefPerson {
  label: string;
  email?: string | null;
  owe: Commitment[];
  waiting: Commitment[];
  oweMore: number;
  waitingMore: number;
}

function namesFor(attendee: BriefAttendee): string[] {
  const full = (attendee.displayName || attendee.name || "").trim().toLocaleLowerCase();
  const local = (attendee.email || "").split("@")[0].trim().toLocaleLowerCase();
  return [...new Set([full, full.split(/\s+/)[0], local].filter(Boolean))];
}

export function personNames(person: string | null): string[] {
  if (!person) return [];
  try {
    const parsed = JSON.parse(person);
    if (Array.isArray(parsed)) return parsed.flatMap((name) => personNames(String(name)));
  } catch {
    /* plain name */
  }
  return [person.trim().toLocaleLowerCase()];
}

export function matchesBriefPerson(person: string | null, attendee: BriefAttendee): boolean {
  const names = namesFor(attendee);
  return names.length > 0 && personNames(person).some((name) => names.includes(name));
}

export function parseBriefAttendees(value: unknown): BriefAttendee[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item === "object" && !item.self)
      : [];
  } catch {
    return [];
  }
}

export function buildPreMeetingBrief(
  attendees: BriefAttendee[],
  rows: Commitment[],
  now = new Date()
): BriefPerson[] {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const sort = (a: Commitment, b: Commitment) => {
    const rank = (row: Commitment) => (!row.due_date ? 2 : row.due_date < today ? 0 : 1);
    return (
      rank(a) - rank(b) ||
      (a.due_date || "").localeCompare(b.due_date || "") ||
      a.created_at.localeCompare(b.created_at)
    );
  };
  return attendees
    .map((attendee) => {
      const matched = rows.filter(
        (row) =>
          (row.status === "open" || row.status === "proposed") &&
          matchesBriefPerson(row.person, attendee)
      );
      const owe = matched.filter((row) => row.direction === "owe").sort(sort);
      const waiting = matched.filter((row) => row.direction === "waiting").sort(sort);
      return {
        label: attendee.displayName || attendee.name || attendee.email?.split("@")[0] || "",
        email: attendee.email,
        owe: owe.slice(0, 5),
        waiting: waiting.slice(0, 5),
        oweMore: Math.max(0, owe.length - 5),
        waitingMore: Math.max(0, waiting.length - 5),
      };
    })
    .filter((person) => person.owe.length || person.waiting.length);
}
