import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, MoreHorizontal } from "../icons";
import type { Commitment } from "../../types/electron";
import { groupFor } from "./TodoGroups";

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
  const overdue = groupFor(row) === "overdue";
  const archived = row.status === "completed" || row.status === "rejected";
  return (
    <article className="group border-b border-border/60 py-3 last:border-0">
      <div className="flex items-start gap-3">
        <button type="button" disabled={archived} onClick={() => onComplete(row)}
          aria-label={t("todos.complete")} className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-border text-primary hover:border-primary focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50">
          {archived && <Check size={13} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className={`text-sm leading-6 ${overdue ? "text-destructive" : "text-foreground"}`}>{row.text}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {row.person && <span className="rounded-full bg-muted px-2 py-0.5">{peopleLabel(row.person)}</span>}
            <span className={overdue ? "font-medium text-destructive" : ""}>{row.due_date || t("todos.noDate")}</span>
            {row.mention_count > 1 && <span>{t("todos.saidCount", { count: row.mention_count })}</span>}
            {Boolean(row.date_move_count) && <span>{t("todos.dateMoved", { count: row.date_move_count })}</span>}
            {row.status === "proposed" && <span>{t("todos.proposed")}</span>}
            {row.source_removed ? <span>{t("todos.sourceRemoved")}</span> : row.source_note_id &&
              <button type="button" onClick={() => onOpenNote(Number(row.source_note_id))}
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 underline underline-offset-2">
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
        </div>
        <details className="relative shrink-0">
          <summary aria-label={t("todos.actions")} className="list-none cursor-pointer rounded p-1 text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"><MoreHorizontal size={18} /></summary>
          <div className="absolute end-0 z-20 mt-1 w-44 rounded-lg border border-border bg-background p-1 shadow-lg text-sm">
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
    </article>
  );
}
