import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "../icons";
import type { Commitment } from "../../types/electron";
import { useTodosStore } from "../../stores/todosStore";
import { groupTodos } from "./TodoGroups";
import TodoRow from "./TodoRow";
import type { AgentJob } from "../../types/electron";
import { addLocalApproval } from "../../stores/localApprovalStore";
import ProposalsBanner from "./ProposalsBanner";
import { filterTodos } from "./todoFilters";

export default function TodosView({ onOpenNote, onOpenAgentJob }: { onOpenNote: (id: number) => void; onOpenAgentJob: (id: string) => void }) {
  const { t } = useTranslation();
  const { rows, showArchived, setShowArchived, refresh, loading, error, filter, setFilter, composerRequestAt } = useTodosStore();
  const [draft, setDraft] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [dueDate, setDueDate] = useState("");
  const draftRef = useRef<HTMLInputElement>(null);
  const lastHandledComposerRequestAt = useRef(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [direction, setDirection] = useState<"owe" | "waiting">("owe");
  const [undo, setUndo] = useState<Commitment | null>(null);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Awaited<ReturnType<typeof window.agentJobs.projectsList>>["projects"]>([]);
  const [jobStatuses, setJobStatuses] = useState<Record<string, AgentJob["status"]>>({});
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let active = true;
    void window.electronAPI.isDebugEnabled().then((enabled) => { if (active) setDebugEnabled(enabled); });
    void window.agentJobs?.projectsList().then((result) => { if (active) setProjects(result.projects); }).catch(() => {});
    const off = window.agentJobs?.onUpdated((job) => setJobStatuses((current) => ({ ...current, [job.jobId]: job.status })));
    return () => { active = false; off?.(); };
  }, []);
  useEffect(() => {
    const ids = [...new Set(rows.map((row) => row.agent_job_id).filter((id): id is string => Boolean(id)))];
    let active = true;
    void Promise.all(ids.map(async (id) => [id, (await window.agentJobs?.get(id))?.status ?? "failed"] as const))
      .then((items) => { if (active) setJobStatuses((current) => ({ ...current, ...Object.fromEntries(items) })); })
      .catch(() => {});
    return () => { active = false; };
  }, [rows]);
  useEffect(() => {
    void refresh();
    const off = window.electronAPI.onCommitmentsUpdated(refresh);
    return () => { off(); if (undoTimer.current) clearTimeout(undoTimer.current); };
  }, [refresh]);
  useEffect(() => {
    if (!composerRequestAt || composerRequestAt === lastHandledComposerRequestAt.current) return;
    if (!composerOpen) {
      setComposerOpen(true);
      return;
    }
    lastHandledComposerRequestAt.current = composerRequestAt;
    draftRef.current?.focus();
  }, [composerRequestAt, composerOpen]);
  const changeStatus = async (row: Commitment, status: "completed" | "rejected", reason: string | null = null) => {
    await window.electronAPI.commitmentsUpdate(row.id, { status, rejected_reason: reason });
    setUndo(row);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 5000);
    await refresh();
  };
  const deleteTodo = async (row: Commitment) => {
    const result = await window.electronAPI.commitmentsDelete(row.id);
    if ("error" in result) { setDeleteError(result.error); return; }
    setDeleteError(null);
    if (undo?.id === row.id) setUndo(null);
    await refresh();
  };
  const handoff = async (row: Commitment, project: string) => {
    if (preparingId) return;
    setPreparingId(row.id);
    setHandoffError(null);
    let jobId: string | null = null;
    try {
      const job = await window.agentJobs.prepare({ project, task: row.text });
      jobId = job.jobId;
      const linked = await window.electronAPI.commitmentsSetAgentJob(row.id, job.jobId);
      if (!linked) throw new Error(t("todos.handoffUnavailable"));
      const context = {
        messageId: `todo-${row.id}-${job.jobId}`, toolCallId: "row",
        signal: new AbortController().signal, onApprovalRequested: () => {}, onHoldDelivery: () => {},
        claimTurnSlot: () => true, releaseTurnSlot: () => {},
      };
      const action = job.prompt.replace(/\s+/g, " ").slice(0, 120);
      addLocalApproval(context, job, `harness ${job.harness} on repo ${job.project.name} with model ${job.model || "default"} for action ${action}`);
      setJobStatuses((current) => ({ ...current, [job.jobId]: "pending" }));
      await refresh();
    } catch (cause) {
      if (jobId) await window.agentJobs.cancel(jobId).catch(() => {});
      setHandoffError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPreparingId(null); }
  };
  const visibleRows = filterTodos(rows, filter);
  const groups = groupTodos(visibleRows);
  return (
    <div className="h-full overflow-y-auto px-5 pb-12 pt-8 sm:px-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div><h1 className="text-2xl font-semibold tracking-tight">{t("todos.title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("todos.subtitle")}</p></div>
          <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <input dir="ltr" type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
            {t("todos.showArchived")}
          </label>
        </div>
        {filter && <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
          <span>{filter.kind === "note" ? t("todos.sourceMeeting") : t("todos.person")}: {filter.value}</span>
          <button type="button" className="text-primary underline" onClick={() => setFilter(null)}>{t("todos.clearFilter")}</button>
        </div>}
        <div className="mb-4 rounded-xl border border-border bg-background shadow-[0_3px_13px_color-mix(in_srgb,var(--color-foreground)_7%,transparent)] focus-within:ring-2 focus-within:ring-primary/25">
          <button ref={triggerRef} type="button" aria-expanded={composerOpen} onClick={() => { setComposerOpen(true); requestAnimationFrame(() => draftRef.current?.focus()); }} className="flex min-h-[45px] w-full items-center gap-[11px] px-[13px] text-left text-sm text-muted-foreground hover:text-foreground">
            <span aria-hidden="true" className="grid size-[21px] place-items-center rounded-full border border-border-hover text-lg font-light leading-none text-foreground"><Plus size={14} /></span>
            {t("todos.addPlaceholder")}
          </button>
          {composerOpen && <form className="px-[14px] pb-3 ps-[37px]" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setComposerOpen(false); triggerRef.current?.focus(); } else if (event.key === "Enter" && event.target === draftRef.current) { event.preventDefault(); event.currentTarget.requestSubmit(); } }}
            onSubmit={async (event) => { event.preventDefault(); if (!draft.trim()) return;
              await window.electronAPI.commitmentsCreate({ text: draft.trim(), direction, ...(dueDate ? { due_date: dueDate } : {}) }); setDraft(""); setDueDate(""); setComposerOpen(false); triggerRef.current?.focus(); await refresh(); }}>
            <input dir="auto" ref={draftRef} className="min-h-[45px] w-full rounded-md bg-transparent px-2 py-1 text-sm text-foreground outline-none focus:outline-none" value={draft}
              onChange={(event) => setDraft(event.target.value)} placeholder={t("todos.addPlaceholder")} aria-label={t("todos.addPlaceholder")} />
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
              <input dir="ltr" type="date" aria-label={t("todos.pickDate")} value={dueDate} onChange={(event) => setDueDate(event.target.value)} className="rounded-md border border-border bg-surface-1 px-2 py-1 text-xs text-foreground" />
              <select value={direction} onChange={(event) => setDirection(event.target.value as "owe" | "waiting")}
                aria-label={t("todos.direction")} className="rounded-md border border-border bg-surface-1 px-2 py-1 text-xs text-foreground">
                <option value="owe">{t("todos.iOwe")}</option><option value="waiting">{t("todos.waitingOn")}</option>
              </select>
              <span className="text-xs text-muted-foreground">Enter to save · Esc to close</span>
              <button type="submit" disabled={!draft.trim()} className="ms-auto rounded-md bg-foreground px-3 py-1.5 text-xs text-background disabled:opacity-50">{t("todos.add")}</button>
            </div>
          </form>}
        </div>
        <ProposalsBanner />
        {undo && <div role="status" className="mb-4 flex items-center gap-4 rounded-xl bg-foreground px-4 py-2 text-xs text-background">
          <span>{t("todos.archived", { text: undo.text })}</span>
          <button type="button" className="rounded px-1 font-bold text-background hover:bg-background/10 focus-visible:outline-2 focus-visible:outline-background" onClick={async () => {
            if (undoTimer.current) clearTimeout(undoTimer.current); await window.electronAPI.commitmentsUpdate(undo.id, { status: "open", rejected_reason: null }); setUndo(null); await refresh();
          }}>{t("todos.undo")}</button>
        </div>}
        {error && <p role="alert" className="mb-4 text-sm text-destructive">{t("todos.loadError")}: {error}</p>}
        {deleteError && <p role="alert" className="mb-4 text-sm text-destructive">{deleteError}</p>}
        {handoffError && <p role="alert" className="mb-4 text-sm text-destructive">{handoffError}</p>}
        {!loading && !groups.length && <p className="py-16 text-center text-sm text-muted-foreground">{showArchived ? t("todos.emptyArchive") : t("todos.empty")}</p>}
        <div className="mt-5 space-y-[26px]">
        {groups.map(({ key, rows: groupRows }) => <section key={key} aria-labelledby={`${key}-heading`} className={`pt-2.5 ${key === "overdue" ? "-mx-[13px] rounded-lg bg-input px-[13px] pb-[3px]" : ""}`}>
          <h2 id={`${key}-heading`} className={`flex items-baseline gap-[7px] text-[11px] font-bold leading-[1.4] tracking-[0.1em] [font-variant-caps:all-small-caps] ${key === "overdue" ? "text-foreground" : "text-muted-foreground"}`}>{t(`todos.groups.${key}`)} <span className="font-medium tracking-normal">{groupRows.length}</span></h2>
          {groupRows.map((row) => <TodoRow key={row.id} row={row} onOpenNote={onOpenNote} debugEnabled={debugEnabled}
            projects={projects.map((project) => project.name)} jobStatus={row.agent_job_id ? jobStatuses[row.agent_job_id] : undefined}
            preparing={preparingId === row.id} onHandoff={(item, project) => void handoff(item, project)} onOpenAgentJob={onOpenAgentJob}
            onDelete={(item) => void deleteTodo(item)}
            onComplete={(item) => void changeStatus(item, "completed")}
            onReject={(item, reason) => void changeStatus(item, "rejected", reason)}
            onDue={(item, input) => void window.electronAPI.commitmentsSetDue(item.id, input).then(() => refresh())}
            onPerson={(item, person) => void window.electronAPI.commitmentsUpdate(item.id, { person }).then(() => refresh())} />)}
        </section>)}
        </div>
      </div>
    </div>
  );
}
