import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, MoreHorizontal, X } from "../icons";
import type { Commitment } from "../../types/electron";
import { groupFor, localDate } from "./TodoGroups";
import { boundedDateLabel } from "./todoDateLabel";
import { LocalApprovalCard } from "../chat/LocalApprovalCard";
import { useLocalApprovalStore } from "../../stores/localApprovalStore";

function peopleLabel(person: string | null): string {
  if (!person) return "";
  try { const parsed = JSON.parse(person); if (Array.isArray(parsed)) return parsed.join(", "); }
  catch { /* plain name */ }
  return person;
}

export default function TodoRow({ row, onComplete, onReject, onDue, onPerson, onOpenNote, onDelete, onHandoff, onOpenAgentJob, projects = [], jobStatus, preparing = false, debugEnabled = false }: {
  row: Commitment;
  onComplete: (row: Commitment) => void;
  onReject: (row: Commitment, reason: string | null) => void;
  onDue: (row: Commitment, input: { action: "push" | "pick" | "clear"; date?: string }) => void;
  onPerson: (row: Commitment, person: string) => void;
  onOpenNote: (id: number) => void;
  onDelete?: (row: Commitment) => void;
  onHandoff?: (row: Commitment, project: string) => void;
  onOpenAgentJob?: (id: string) => void;
  projects?: string[];
  jobStatus?: "pending" | "queued" | "running" | "done" | "failed" | "cancelled";
  preparing?: boolean;
  debugEnabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [editingPerson, setEditingPerson] = useState(false);
  const [person, setPerson] = useState(peopleLabel(row.person));
  const [rejecting, setRejecting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [project, setProject] = useState(projects[0] || "");
  const approval = useLocalApprovalStore((state) => Object.values(state.entries).find((entry) => entry.messageId.startsWith(`todo-${row.id}-`) && entry.jobId === row.agent_job_id));
  const receipt = useLocalApprovalStore((state) => Object.values(state.receipts).find((entry) => entry.messageId.startsWith(`todo-${row.id}-`) && entry.jobId === row.agent_job_id));
  const effectiveStatus = receipt?.state === "failed" || receipt?.state === "cancelled" ? receipt.state : jobStatus;
  const inactiveJob = effectiveStatus === "failed" || effectiveStatus === "cancelled";
  const actionableJob = Boolean(effectiveStatus) && !inactiveJob;
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const rejectInputRef = useRef<HTMLInputElement>(null);
  const startReject = () => {
    setRejectReason("");
    setRejecting(true);
    if (detailsRef.current) detailsRef.current.open = false;
  };
  const now = new Date();
  const overdue = groupFor(row, now) === "overdue";
  const today = row.due_date === localDate(now) && !overdue;
  const due = row.due_date ? new Date(`${row.due_date}T12:00:00`) : null;
  const locale = i18n.language;
  const fullDate = due ? new Intl.DateTimeFormat(locale, { dateStyle: "full" }).format(due) : undefined;
  let dateLabel = t("todos.noDate");
  let dateStatus: string | undefined;
  if (due) {
    const day = new Intl.DateTimeFormat(locale, { day: "numeric" }).format(due);
    const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(due);
    const month = new Intl.DateTimeFormat(locale, { month: "short" }).format(due);
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const sixDaysAway = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 6);
    const numericDate = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit" }).format(due);
    if (today) dateStatus = t("todos.groups.today");
    else if (row.due_date === localDate(tomorrow)) dateStatus = t("todos.tomorrow");
    if (dateStatus) dateLabel = boundedDateLabel(dateStatus, numericDate, "semantic");
    else if (row.due_date > localDate(now) && row.due_date <= localDate(sixDaysAway))
      dateLabel = boundedDateLabel(`${weekday} ${day}`, numericDate, "composed");
    else dateLabel = boundedDateLabel(`${day} ${month}${due.getFullYear() === now.getFullYear() ? "" : ` ${due.getFullYear()}`}`, numericDate, "composed");
  }
  const dateDescription = due ? `${overdue ? `${t("todos.groups.overdue")} · ` : dateStatus ? `${dateStatus} · ` : ""}${fullDate}` : undefined;
  const archived = row.status === "completed" || row.status === "rejected";
  const statusClass = row.status === "completed"
    ? "border-primary/20 bg-primary/10 text-primary"
    : row.status === "rejected"
      ? "border-destructive/20 bg-destructive/10 text-destructive"
      : "border-border-hover bg-background text-transparent hover:border-primary hover:text-primary focus-visible:outline-2 focus-visible:outline-primary";
  return (
    <article data-overdue={overdue ? "true" : undefined} className={`group relative grid min-h-[46px] grid-cols-[22px_minmax(0,1fr)_76px] items-start gap-x-2.5 border-b border-border py-2.5 transition-colors duration-150 ease-out hover:bg-surface-1 motion-reduce:transition-none last:border-0 ${overdue ? "ps-[9px] before:absolute before:inset-y-[9px] before:start-0 before:w-px before:bg-destructive" : ""}`}>
        <button type="button" disabled={archived} onClick={() => onComplete(row)}
          aria-label={t(archived ? `todos.${row.status}` : "todos.complete")}
          title={row.status === "rejected" ? row.rejected_reason || undefined : undefined}
          className={`mt-0.5 grid size-[17px] shrink-0 place-items-center rounded-full border ${statusClass}`}>
          {row.status === "completed" && <Check size={13} />}
          {row.status === "rejected" && <X size={13} />}
        </button>
        <div className="min-w-0">
          <div className="text-[13px] font-medium leading-[1.55] text-foreground">{row.text}</div>
          <div className="mt-[3px] flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {row.person && <span className="inline-flex items-center gap-1 rounded-full bg-input px-2 py-[3px] text-foreground"><span aria-hidden="true" className="grid size-[14px] place-items-center rounded-full bg-border text-[9px] font-bold">{peopleLabel(row.person).charAt(0).toUpperCase()}</span>{peopleLabel(row.person)}</span>}
            {row.mention_count > 1 && <span>{t("todos.saidCount", { count: row.mention_count })}</span>}
            {Boolean(row.date_move_count) && <span>{t("todos.dateMoved", { count: row.date_move_count })}</span>}
            {row.status === "proposed" && <span>{t("todos.proposed")}</span>}
            {archived && <span>{t(`todos.${row.status}`)}</span>}
            {row.source === "agent" && row.source_agent && <span className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-[7px] py-0.5 text-muted-foreground"><span aria-hidden="true" className="size-[7px] rotate-45 rounded-[2px] bg-agent-brand" />{row.source_agent}</span>}
            {row.agent_job_id && (!actionableJob ?
              <span title={inactiveJob ? t(effectiveStatus === "cancelled" ? "todos.handoffCancelled" : "todos.handoffFailed") : undefined} className="rounded-full bg-surface-3 px-[7px] py-0.5 text-muted-foreground opacity-70">{t("todos.handedOff")}</span> :
              <button type="button" title={t("todos.openAgentJob")} onClick={() => onOpenAgentJob?.(row.agent_job_id!)} className="rounded-full bg-surface-3 px-[7px] py-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary">{t("todos.handedOff")}</button>)}
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
          {rejecting && <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(event) => {
            event.preventDefault();
            onReject(row, rejectReason || null);
            setRejecting(false);
          }} onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); setRejecting(false); }
            else if (event.key === "Enter" && event.target === rejectInputRef.current) {
              event.preventDefault(); event.currentTarget.requestSubmit();
            }
          }}>
            <input ref={rejectInputRef} autoFocus aria-label={t("todos.rejectReason")} placeholder={t("todos.rejectReason")}
              value={rejectReason} onChange={(event) => setRejectReason(event.target.value)}
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm" />
            <button type="submit" className="text-sm text-destructive">{t("todos.reject")}</button>
            <button type="button" onClick={() => setRejecting(false)} className="text-sm text-muted-foreground hover:text-foreground">{t("common.cancel")}</button>
          </form>}
          {approval && <div className="mt-2"><LocalApprovalCard entry={approval} compact /></div>}
          {row.quote && <button type="button" onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded} className="mt-1 text-xs text-muted-foreground underline underline-offset-2">
            {expanded ? t("todos.hideQuote") : t("todos.showQuote")}
          </button>}
          {expanded && row.quote && <blockquote className="mt-2 border-s border-border ps-3 text-sm text-muted-foreground">“{row.quote}”</blockquote>}
          <div data-todo-actions className="mt-[3px] flex flex-wrap items-center gap-x-3 gap-y-1 opacity-0 transition-opacity duration-[120ms] ease-out group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100">
            {!archived && <button type="button" className="text-xs text-muted-foreground underline decoration-border-hover underline-offset-2 hover:text-foreground" onClick={() => onComplete(row)}>{t("todos.complete")}</button>}
            {!archived && <button type="button" className="text-xs text-muted-foreground underline decoration-border-hover underline-offset-2 hover:text-foreground" onClick={startReject}>{t("todos.reject")}</button>}
            <button type="button" className="text-xs text-muted-foreground underline decoration-border-hover underline-offset-2 hover:text-foreground" onClick={() => { if (detailsRef.current) detailsRef.current.open = true; }}>{t("todos.pickDate")}</button>
            <details ref={detailsRef} className="relative text-xs">
              <summary aria-label={t("todos.actions")} className="list-none cursor-pointer rounded text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"><MoreHorizontal size={16} /></summary>
              <div className="absolute start-0 z-20 mt-1 w-44 rounded-lg border border-border bg-background p-1 shadow-lg text-sm">
                {confirmingDelete ? <div className="space-y-2 p-2">
                  <p className="text-xs text-foreground">{t("todos.deleteConfirm")}</p>
                  <button type="button" className="block w-full rounded px-2 py-1.5 text-start text-destructive hover:bg-muted" onClick={() => { setConfirmingDelete(false); detailsRef.current?.removeAttribute("open"); onDelete?.(row); }}>{t("todos.deletePermanently")}</button>
                  <button type="button" className="block w-full rounded px-2 py-1.5 text-start hover:bg-muted" onClick={() => setConfirmingDelete(false)}>{t("common.cancel")}</button>
                </div> : <>
                <button className="block w-full rounded px-2 py-1.5 text-start hover:bg-muted" onClick={() => { setEditingPerson(true); }} type="button">{t("todos.editPerson")}</button>
                <label className="block rounded px-2 py-1.5 hover:bg-muted">{t("todos.pickDate")}
                  <input type="date" className="mt-1 w-full bg-background" value={row.due_date || ""}
                    onChange={(event) => { if (event.target.value) onDue(row, { action: "pick", date: event.target.value }); }} />
                </label>
                <button className="block w-full rounded px-2 py-1.5 text-start hover:bg-muted" onClick={() => onDue(row, { action: "push" })} type="button">{t("todos.pushDay")}</button>
                <button className="block w-full rounded px-2 py-1.5 text-start hover:bg-muted" onClick={() => onDue(row, { action: "clear" })} type="button">{t("todos.clearDate")}</button>
                {!archived && projects.length > 0 && (!row.agent_job_id || inactiveJob) && <div className="border-t border-border pt-1">
                  {projects.length > 1 && <label className="block px-2 py-1 text-xs text-muted-foreground">{t("todos.agentProject")}
                    <select aria-label={t("todos.agentProject")} className="mt-1 w-full rounded border border-border bg-background px-1 py-1 text-foreground" value={projects.includes(project) ? project : projects[0]} onChange={(event) => setProject(event.target.value)}>
                      {projects.map((name) => <option key={name} value={name}>{name}</option>)}
                    </select>
                  </label>}
                  <button className="block w-full rounded px-2 py-1.5 text-start hover:bg-muted disabled:opacity-50" disabled={preparing} onClick={() => { detailsRef.current?.removeAttribute("open"); onHandoff?.(row, projects.includes(project) ? project : projects[0]); }} type="button">{t("todos.sendToAgent")}</button>
                </div>}
                {!archived && <button className="block w-full rounded px-2 py-1.5 text-start hover:bg-muted" onClick={() => onComplete(row)} type="button">{t("todos.complete")}</button>}
                {!archived && <button className="block w-full rounded px-2 py-1.5 text-start text-destructive hover:bg-muted" onClick={startReject} type="button">{t("todos.reject")}</button>}
                {debugEnabled && <button className="block w-full rounded px-2 py-1.5 text-start text-destructive hover:bg-muted" onClick={() => setConfirmingDelete(true)} type="button">{t("todos.delete")}</button>}
                </>}
              </div>
            </details>
          </div>
        </div>
        <span data-todo-date-column className="col-start-3 row-start-1 flex w-[76px] justify-end text-right"><span title={dateDescription} aria-label={dateDescription} className={`inline-flex min-h-5 items-center justify-end whitespace-nowrap rounded-full px-1 py-px text-[11px] leading-4 tabular-nums ${overdue ? "bg-[color:color-mix(in_srgb,var(--color-destructive)_4%,var(--color-background))] text-destructive dark:text-[color:color-mix(in_srgb,var(--color-destructive)_80%,var(--color-foreground))]" : today ? "bg-[color:color-mix(in_srgb,var(--color-warning)_9%,var(--color-background))] text-foreground" : row.due_date ? "bg-surface-3 text-muted-foreground dark:text-foreground/80" : "text-muted-foreground"}`}>{dateLabel}</span></span>
    </article>
  );
}
