import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "../icons";
import type { Commitment } from "../../types/electron";
import { useTodosStore } from "../../stores/todosStore";
import { groupTodos } from "./TodoGroups";
import TodoRow from "./TodoRow";
import ProposalsBanner from "./ProposalsBanner";

export default function TodosView({ onOpenNote }: { onOpenNote: (id: number) => void }) {
  const { t } = useTranslation();
  const { rows, showArchived, setShowArchived, refresh, loading, error } = useTodosStore();
  const [draft, setDraft] = useState("");
  const [direction, setDirection] = useState<"owe" | "waiting">("owe");
  const [undo, setUndo] = useState<Commitment | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    void refresh();
    const off = window.electronAPI.onCommitmentsUpdated(refresh);
    return () => { off(); if (undoTimer.current) clearTimeout(undoTimer.current); };
  }, [refresh]);
  const changeStatus = async (row: Commitment, status: "completed" | "rejected", reason: string | null = null) => {
    await window.electronAPI.commitmentsUpdate(row.id, { status, rejected_reason: reason });
    setUndo(row);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 5000);
    await refresh();
  };
  const groups = groupTodos(rows);
  return (
    <div className="h-full overflow-y-auto px-5 pb-12 pt-8 sm:px-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div><h1 className="text-2xl font-semibold tracking-tight">{t("todos.title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("todos.subtitle")}</p></div>
          <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
            {t("todos.showArchived")}
          </label>
        </div>
        <form className="mb-6 flex items-center gap-2 rounded-xl border border-border bg-background p-2 focus-within:ring-2 focus-within:ring-primary/25"
          onSubmit={async (event) => { event.preventDefault(); if (!draft.trim()) return;
            await window.electronAPI.commitmentsCreate({ text: draft.trim(), direction }); setDraft(""); await refresh(); }}>
          <Plus size={18} className="ms-2 shrink-0 text-muted-foreground" />
          <input className="min-w-0 flex-1 bg-transparent px-1 py-2 text-sm outline-none" value={draft}
            onChange={(event) => setDraft(event.target.value)} placeholder={t("todos.addPlaceholder")} aria-label={t("todos.addPlaceholder")} />
          <select value={direction} onChange={(event) => setDirection(event.target.value as "owe" | "waiting")}
            aria-label={t("todos.direction")} className="rounded border border-border bg-background px-2 py-1 text-xs">
            <option value="owe">{t("todos.iOwe")}</option><option value="waiting">{t("todos.waitingOn")}</option>
          </select>
          <button type="submit" disabled={!draft.trim()} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">{t("todos.add")}</button>
        </form>
        <ProposalsBanner />
        {undo && <div role="status" className="mb-4 flex items-center gap-3 rounded-lg bg-muted px-4 py-2 text-sm">
          <span>{t("todos.archived", { text: undo.text })}</span>
          <button type="button" className="font-medium text-primary underline underline-offset-2" onClick={async () => {
            if (undoTimer.current) clearTimeout(undoTimer.current); await window.electronAPI.commitmentsUpdate(undo.id, { status: "open", rejected_reason: null }); setUndo(null); await refresh();
          }}>{t("todos.undo")}</button>
        </div>}
        {error && <p role="alert" className="mb-4 text-sm text-destructive">{t("todos.loadError")}: {error}</p>}
        {!loading && !groups.length && <p className="py-16 text-center text-sm text-muted-foreground">{showArchived ? t("todos.emptyArchive") : t("todos.empty")}</p>}
        {groups.map(({ key, rows: groupRows }) => <section key={key} className="mb-8">
          <h2 className="mb-2 border-b border-border pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t(`todos.groups.${key}`)}</h2>
          {groupRows.map((row) => <TodoRow key={row.id} row={row} onOpenNote={onOpenNote}
            onComplete={(item) => void changeStatus(item, "completed")}
            onReject={(item, reason) => void changeStatus(item, "rejected", reason)}
            onDue={(item, input) => void window.electronAPI.commitmentsSetDue(item.id, input).then(() => refresh())}
            onPerson={(item, person) => void window.electronAPI.commitmentsUpdate(item.id, { person }).then(() => refresh())} />)}
        </section>)}
      </div>
    </div>
  );
}
