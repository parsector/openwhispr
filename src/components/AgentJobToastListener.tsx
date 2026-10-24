import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ToastActionButton } from "./ui/Toast";
import { useToast } from "./ui/useToast";
import { failureDescription } from "./integrations/agentJobsPresentation";

/** Listens once at the control-panel level so completion is visible outside Settings. */
export function AgentJobToastListener() {
  const { t } = useTranslation();
  const { toast, dismiss } = useToast();
  const notified = useRef(new Set<string>());
  useEffect(
    () =>
      window.agentJobs?.onUpdated((job) => {
        if (job.status !== "done" && job.status !== "failed" && !(job.status === "cancelled" && job.mode === "write" && job.worktreePath)) return;
        const key = `${job.jobId}:${job.status}`;
        if (notified.current.has(key)) return;
        notified.current.add(key);
        if (job.status === "done") {
          let toastId: string;
          toastId = toast({
            title: t("agentJobs.toast.done", { project: job.project.name }),
            variant: "success",
            duration: 10000,
            action: job.noteId ? (
              <ToastActionButton
                onClick={() => {
                  void window.electronAPI.agentOpenNote?.(job.noteId!).then(() => dismiss(toastId));
                }}
              >
                {t("agentJobs.pane.openNote")}
              </ToastActionButton>
            ) : undefined,
          });
        } else {
          toast({
            title: job.status === "cancelled"
              ? t("agentJobs.pane.failure.cancelled")
              : t("agentJobs.toast.failed", { project: job.project.name }),
            description: failureDescription(job.reason || (job.status === "cancelled" ? "cancelled" : null), job.lastError, t, job.harness, job.mode === "write" ? job : undefined),
            variant: "destructive",
            duration: 10000,
          });
        }
      }),
    [toast, dismiss, t]
  );
  return null;
}
