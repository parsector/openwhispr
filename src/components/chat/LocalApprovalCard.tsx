import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { guaranteeKey } from "../integrations/agentJobsPresentation";
import {
  approveLocal,
  cancelLocal,
  updateLocalApprovalJob,
  updateLocalPrompt,
  type LocalApprovalEntry,
} from "../../stores/localApprovalStore";

export function LocalApprovalCard({ entry }: { entry: LocalApprovalEntry }) {
  const { t } = useTranslation();
  useEffect(
    () =>
      window.agentJobs.onUpdated((job) => {
        if (job.jobId === entry.jobId) updateLocalApprovalJob(job);
      }),
    [entry.jobId]
  );
  const busy = entry.state === "approving" || entry.state === "cancelling";
  const pending = entry.state === "pending" || busy;
  return (
    <section
      className="rounded-md border border-border bg-surface-1 p-3 space-y-2"
      aria-label={t("agentJobs.card.title")}
    >
      <p className="text-sm font-medium">{entry.summary}</p>
      <p className="text-xs text-muted-foreground">
        {entry.mode &&
          entry.mode !== "write" &&
          `${t(entry.mode === "read-only" ? "agentJobs.pane.readOnly" : `agentJobs.mode.${entry.mode}`)} · `}
        {t(guaranteeKey(entry.harness, entry.mode))}
      </p>
      {entry.authWarning && entry.harness === "claude" && (
        <p className="text-xs text-warning" role="status">
          {t("agentJobs.pane.authSoftWarning")}
        </p>
      )}
      {entry.mode === "write" && entry.branch && (
        <p className="text-xs text-muted-foreground break-all">
          {t("agentJobs.card.branch")}: {entry.branch}
        </p>
      )}
      <p className="text-xs text-muted-foreground" role="status">
        {t(`agentJobs.card.${entry.state}`)}
      </p>
      {pending && (
        <>
          <label className="block text-xs" htmlFor={`agent-prompt-${entry.key}`}>
            {t("agentJobs.card.prompt")}
          </label>
          <textarea
            id={`agent-prompt-${entry.key}`}
            className="w-full min-h-28 rounded-md border border-border bg-background p-2 text-sm"
            value={entry.prompt}
            onChange={(event) => updateLocalPrompt(entry.key, event.target.value)}
            disabled={busy}
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !entry.prompt.trim()}
              onClick={() => void approveLocal(entry.key)}
            >
              {t("agentJobs.card.approve")}
            </button>
            <button type="button" disabled={busy} onClick={() => void cancelLocal(entry.key)}>
              {t("agentJobs.card.cancel")}
            </button>
          </div>
        </>
      )}
      {entry.error && (
        <p role="alert" className="text-xs text-destructive">
          {t("agentJobs.pane.actionError")}: {entry.error}
        </p>
      )}
    </section>
  );
}
