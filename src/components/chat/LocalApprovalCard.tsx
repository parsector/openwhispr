import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cursorTrustKey, guaranteeKey } from "../integrations/agentJobsPresentation";
import {
  approveLocal,
  cancelLocal,
  updateLocalApprovalJob,
  updateLocalPrompt,
  type LocalApprovalEntry,
} from "../../stores/localApprovalStore";

export function LocalApprovalCard({ entry }: { entry: LocalApprovalEntry }) {
  const { t } = useTranslation();
  const [notes, setNotes] = useState<Array<{ id: number; title: string; content?: string | null; enhanced_content?: string | null }>>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<number | undefined>();
  useEffect(() => {
    if (entry.contextNoteId) return;
    let live = true;
    void window.electronAPI.getNotes(null, 500, null).then((items) => {
      if (live) setNotes(items.filter((note) => !note.deleted_at));
    }).catch(() => {});
    return () => { live = false; };
  }, [entry.contextNoteId]);
  const selectedNote = notes.find((note) => note.id === selectedNoteId);
  const contextTitle = entry.contextNoteTitle ?? selectedNote?.title;
  const selectedText = selectedNote
    ? [selectedNote.content, selectedNote.enhanced_content].filter(Boolean).join("\n\n")
    : "";
  const contextChars = entry.contextChars ?? (selectedText
    ? Math.min(12000, Array.from(selectedText).length) +
      (Array.from(selectedText).length > 12000 ? Array.from("… [note truncated at 12000 characters]").length : 0)
    : 0);
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
      {entry.harness === "cursor-agent" && (
        <p className="text-xs text-muted-foreground">
          {t(cursorTrustKey(Boolean(entry.trustWorkspace)))}
        </p>
      )}
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
      {contextTitle && (
        <>
          <p className="text-xs text-muted-foreground">{t("agentJobs.card.context", { title: contextTitle, count: contextChars })}</p>
          <p className="text-xs text-warning">{t("agentJobs.card.contextPrivacy")}</p>
        </>
      )}
      {entry.contextDropped && <p className="text-xs text-warning" role="status">{t("agentJobs.card.contextDropped")}</p>}
      <p className="text-xs text-muted-foreground" role="status">
        {t(`agentJobs.card.${entry.state}`)}
      </p>
      {pending && (
        <>
          {!entry.contextNoteId && notes.length > 0 && (
            <label className="block text-xs">
              {t("agentJobs.card.attachNote")}
              <select className="ml-2 rounded border border-border bg-background" value={selectedNoteId ?? ""}
                onChange={(event) => setSelectedNoteId(event.target.value ? Number(event.target.value) : undefined)} disabled={busy}>
                <option value="">{t("agentJobs.card.noNote")}</option>
                {notes.map((note) => <option key={note.id} value={note.id}>{note.title}</option>)}
              </select>
            </label>
          )}
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
              onClick={() => void approveLocal(entry.key, selectedNoteId)}
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
