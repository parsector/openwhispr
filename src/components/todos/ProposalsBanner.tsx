import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useTodosStore } from "../../stores/todosStore";
import type { CommitmentProposal } from "../../types/electron";

export default function ProposalsBanner({ noteId, compact = false, items }: { noteId?: number; compact?: boolean; items?: CommitmentProposal[] }) {
  const { t } = useTranslation();
  const proposals = useTodosStore((state) => state.proposals);
  const refresh = useTodosStore((state) => state.refresh);
  useEffect(() => {
    void refresh();
    return window.electronAPI.onCommitmentsUpdated(refresh);
  }, [refresh]);
  const source = items ?? proposals;
  const visible = noteId == null ? source : source.filter((proposal) => proposal.note_id === String(noteId));
  if (!visible.length) return null;
  return <section className={`rounded-xl bg-primary/5 p-4 ${compact ? "max-h-96 overflow-y-auto" : "mb-6"}`}
    aria-label={t("todos.proposalsTitle")}>
    <h2 className="text-sm font-semibold text-foreground">{t("todos.proposalsTitle")}</h2>
    <p className="mt-1 text-xs text-muted-foreground">{t("todos.proposalsDescription")}</p>
    <div className="mt-3 space-y-3">
      {visible.map((proposal) => <div key={proposal.id} className="border-t border-border/60 pt-3 first:border-0 first:pt-0">
        <p className="text-sm font-medium text-foreground">{proposal.text}</p>
        <blockquote className="mt-1 text-xs text-muted-foreground">“{proposal.quote}”</blockquote>
        {proposal.strength === "second_hand" && <span className="text-xs text-muted-foreground">{t("todos.secondHand")}</span>}
        <div className="mt-2 flex gap-3 text-xs">
          <button type="button" className="font-medium text-primary underline underline-offset-2"
            onClick={async () => { await window.electronAPI.commitmentsResolveProposal(proposal.id, true); await refresh(); }}>
            {t("todos.acceptCompletion")}
          </button>
          <button type="button" className="text-muted-foreground underline underline-offset-2"
            onClick={async () => { await window.electronAPI.commitmentsResolveProposal(proposal.id, false); await refresh(); }}>
            {t("todos.keepOpen")}
          </button>
        </div>
      </div>)}
    </div>
  </section>;
}
