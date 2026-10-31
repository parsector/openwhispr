import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useTodosStore } from "../../stores/todosStore";
import type { CommitmentProposal } from "../../types/electron";
import { plainTodoText } from "./todoMentionDisplay";

export default function ProposalsBanner({
  noteId,
  compact = false,
  items,
}: {
  noteId?: number;
  compact?: boolean;
  items?: CommitmentProposal[];
}) {
  const { t } = useTranslation();
  const proposals = useTodosStore((state) => state.proposals);
  const refresh = useTodosStore((state) => state.refresh);
  useEffect(() => {
    void refresh();
    return window.electronAPI.onCommitmentsUpdated(refresh);
  }, [refresh]);
  const source = items ?? proposals;
  const visible =
    noteId == null ? source : source.filter((proposal) => proposal.note_id === String(noteId));
  if (!visible.length) return null;
  return (
    <section
      className={`${compact ? "max-h-96 overflow-y-auto" : ""}`}
      aria-label={t("todos.proposalsTitle")}
    >
      <div className="flex min-h-[37px] items-center gap-2 border-y border-border py-[7px] text-xs">
        <span
          aria-hidden="true"
          className="size-[7px] shrink-0 rotate-45 rounded-[2px] bg-agent-brand"
        />
        <h2 className="font-semibold text-foreground">{t("todos.proposalsTitle")}</h2>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t("todos.proposalsDescription")}</p>
      <div className="mt-3">
        {visible.map((proposal) => (
          <div
            key={proposal.id}
            className="border-t border-border py-2.5 first:border-0 first:pt-0"
          >
            <p className="text-xs font-semibold leading-[1.4] text-foreground">
              {plainTodoText(proposal.text)}
            </p>
            {proposal.quote && (
              <blockquote className="mt-1 border-s border-border-hover ps-2.5 text-xs leading-normal text-muted-foreground">
                “{proposal.quote}”
              </blockquote>
            )}
            {proposal.strength === "second_hand" && (
              <span className="text-xs text-muted-foreground">{t("todos.secondHand")}</span>
            )}
            <div className="mt-[7px] flex gap-3 text-xs">
              <button
                type="button"
                className="font-semibold text-foreground hover:underline"
                onClick={async () => {
                  await window.electronAPI.commitmentsResolveProposal(proposal.id, true);
                  await refresh();
                }}
              >
                {t("todos.acceptCompletion")}
              </button>
              <button
                type="button"
                className="text-muted-foreground hover:underline"
                onClick={async () => {
                  await window.electronAPI.commitmentsResolveProposal(proposal.id, false);
                  await refresh();
                }}
              >
                {t("todos.keepOpen")}
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
