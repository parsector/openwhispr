import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { AgentJob } from "../types/electron";
import { deliverJobMessage } from "../services/agents/jobDelivery";

/** Lives in the always-created pill window, including when the control panel is closed. */
export function AgentJobDeliveryListener() {
  const { t } = useTranslation();
  useEffect(() => {
    const deliver = (job: AgentJob) => {
      if (job.status !== "done" && job.status !== "failed") return;
      void deliverJobMessage(job, t, (id, role, content, metadata) =>
        window.electronAPI.addAgentMessage!(id, role, content, metadata)
      );
    };
    const unsubscribe = window.agentJobs?.onUpdated?.(deliver);
    // Reconcile terminal jobs after a renderer reload or an app restart.
    if (window.agentJobs?.list)
      void window.agentJobs
        .list()
        .then((jobs) => jobs.forEach(deliver))
        .catch(() => {});
    return unsubscribe;
  }, [t]);
  return null;
}
