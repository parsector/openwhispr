import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, MoreHorizontal } from "../icons";
import type { Commitment } from "../../types/electron";
import { groupFor, localDate } from "./TodoGroups";

function peopleLabel(person: string | null): string {
  if (!person) return "";
  try { const parsed = JSON.parse(person); if (Array.isArray(parsed)) return parsed.join(", "); }
  catch { /* plain name */ }
  return person;
}

export default function TodoRow({ row, onComplete, onReject, onDue, onPerson, onOpenNote }: {
  row: Commitment;
  onComplete: (row: Commitment) => void;
  onReject: (row: Commitment, reason: string | null) => void;
  onDue: (row: Commitment, input: { action: "push" | "pick" | "clear"; date?: string }) => void;
  onPerson: (row: Commitment, person: string) => void;
  onOpenNote: (id: number) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [editingPerson, setEditingPerson] = useState(false);
  const [person, setPerson] = useState(peopleLabel(row.person));
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const overdue = groupFor(row) === "overdue";
  const today = row.due_date === localDate(new Date()) && !overdue;
  const archived = row.status === "completed" || row.status === "rejected";
  return (
    <article data-overdue={overdue ? "true" : undefined} className={`group relative grid min-h-[46px] grid-cols-[22px_minmax(0,1fr)_76px] items-start gap-x-2.5 border-b border-border py-2.5 transition-colors duration-150 ease-out hover:bg-surface-1 motion-reduce:transition-none last:border-0 ${overdue ? "ps-[9px] before:absolute before:inset-y-[9px] before:start-0 before:w-px before:bg-destructive" : ""}`}>
        <button type="button" disabled={archived} onClick={() => onComplete(row)}
          aria-label={t("todos.complete")} className="mt-0.5 grid size-[17px] shrink-0 place-items-center rounded-full border border-border-hover bg-background text-transparent hover:border-primary hover:text-primary focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50">
          {archived && <Check size={13} />}
        </button>
        <div className="min-w-0">
          <div className="text-[13px] font-medium leading-[1.55] text-foreground">{row.text}</div>
          <div className="mt-[3px] flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {row.person && <span className="inline-flex items-center gap-1 rounded-full bg-input px-2 py-[3px] text-foreground"><span aria-hidden="true" className="grid size-[14px] place-items-center rounded-full bg-border text-[9px] font-bold">{peopleLabel(row.person).charAt(0).toUpperCase()}</span>{peopleLabel(row.person)}</span>}
            {row.mention_count > 1 && <span>{t("todos.saidCount", { count: row.mention_count })}</span>}
            {Boolean(row.date_move_count) && <span>{t("todos.dateMoved", { count: row.date_move_count })}</span>}
            {row.status === "proposed" && <span>{t("todos.proposed")}</span>}
            {row.source === "agent" && row.source_agent && <span className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-[7px] py-0.5 text-muted-foreground"><span aria-hidden="true" className="size-[7px] rotate-45 rounded-[2px] bg-agent-brand" />{row.source_agent}</span>}
            {row.source_removed ? <span>{t("todos.sourceRemoved")}</span> : row.source_note_id &&
              <button type="button" onClick={() => onOpenNote(Number(row.source_note_id))}
                className="hover:underline focus-visible:underline underline-offset-2">
                {row.source_note_title || t("todos.sourceMeeting")}
              </button>}
          </div>
          {editingPerson && <form className="mt-2 flex gap-2" onSubmit={(event) => { event.preventDefault(); onPerson(row, person); setEditingPerson(false); }}>
            <input aria-label={t("todos.person")} value={person} onChange={(event) => setPerson(event.target.value)}
              className="rounded border border-border bg-background px-2 py-1 text-sm" />
            <button type="submit" className="text-sm text-primary">{t("todos.save")}</button>
          </form>}
          {row.quote && <button type="button" onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded} className="mt-1 text-xs text-muted-foreground underline underline-offset-2">
            {expanded ? t("todos.hideQuote") : t("todos.showQuote")}
          </button>}
          {expanded && row.quote && <blockquote className="mt-2 border-s border-border ps-3 text-sm text-muted-foreground">“{row.quote}”</blockquote>}
          <div data-todo-actions className="mt-[3px] flex flex-wrap items-center gap-x-3 gap-y-1 opacity-0 transition-opacity duration-[120ms] ease-out group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100">
            {!archived && <button type="button" className="text-xs text-muted-foreground underline decoration-border-hover underline-offset-2 hover:text-foreground" onClick={() => onComplete(row)}>{t("todos.complete")}</button>}
            {!archived && <button type="button" className="text-xs text-muted-foreground underline decoration-border-hover underline-offset-2 hover:text-foreground" onClick={() => { const reason = window.prompt(t("todos.rejectReason")); if (reason !== null) onReject(row, reason || null); }}>{t("todos.reject")}</button>}
            <button type="button" className="text-xs text-muted-foreground underline decoration-border-hover underline-offset-2 hover:text-foreground" onClick={() => { if (detailsRef.current) detailsRef.current.open = true; }}>{t("todos.pickDate")}</button>
            <details ref={detailsRef} className="relative text-xs">
              <summary aria-label={t("todos.actions")} className="list-none cursor-pointer rounded text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"><MoreHorizontal size={16} /></summary>
              <div className="absolute start-0 z-20 mt-1 w-44 rounded-lg border border-border bg-background p-1 shadow-lg text-sm">
                <button className="block w-full rounded px-2 py-1.5 text-start hover:bg-muted" onClick={() => { setEditingPerson(true); }} type="button">{t("todos.editPerson")}</button>
                <label className="block rounded px-2 py-1.5 hover:bg-muted">{t("todos.pickDate")}
                  <input type="date" className="mt-1 w-full bg-background" value={row.due_date || ""}
                    onChange={(event) => { if (event.target.value) onDue(row, { action: "pick", date: event.target.value }); }} />
                </label>
                <button className="block w-full rounded px-2 py-1.5 text-start hover:bg-muted" onClick={() => onDue(row, { action: "push" })} type="button">{t("todos.pushDay")}</button>
                <button className="block w-full rounded px-2 py-1.5 text-start hover:bg-muted" onClick={() => onDue(row, { action: "clear" })} type="button">{t("todos.clearDate")}</button>
                {!archived && <button className="block w-full rounded px-2 py-1.5 text-start hover:bg-muted" onClick={() => onComplete(row)} type="button">{t("todos.complete")}</button>}
                {!archived && <button className="block w-full rounded px-2 py-1.5 text-start text-destructive hover:bg-muted" onClick={() => {
                  const reason = window.prompt(t("todos.rejectReason"));
                  if (reason !== null) onReject(row, reason || null);
                }} type="button">{t("todos.reject")}</button>}
              </div>
            </details>
          </div>
        </div>
        <span data-todo-date-column className="col-start-3 row-start-1 flex w-[76px] justify-end text-right"><span className={`inline-flex min-h-5 items-center justify-end whitespace-nowrap rounded-full px-1 py-px text-[11px] leading-4 tabular-nums ${overdue ? "bg-[color:color-mix(in_srgb,var(--color-destructive)_4%,var(--color-background))] text-destructive dark:text-[color:color-mix(in_srgb,var(--color-destructive)_80%,var(--color-foreground))]" : today ? "bg-[color:color-mix(in_srgb,var(--color-warning)_9%,var(--color-background))] text-foreground" : row.due_date ? "bg-surface-3 text-muted-foreground dark:text-foreground/80" : "text-muted-foreground"}`}>{row.due_date || t("todos.noDate")}</span></span>
    </article>
  );
}
