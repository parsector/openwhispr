export type JobStatus = "pending" | "queued" | "running" | "done" | "failed" | "cancelled";
export type JobSeverity = "neutral" | "info" | "success" | "danger" | "warning";

export function jobStatus(
  status: JobStatus,
  stalled: boolean
): { key: string; severity: JobSeverity } {
  if (status === "running" && stalled) return { key: "stalled", severity: "warning" };
  const severity: Record<JobStatus, JobSeverity> = {
    pending: "neutral",
    queued: "info",
    running: "info",
    done: "success",
    failed: "danger",
    cancelled: "neutral",
  };
  return { key: status, severity: severity[status] };
}

export function queuePosition(position: number | null): string | null {
  return position !== null && position > 0 ? String(position) : null;
}

export function elapsedTime(
  startedAt: number | null,
  endedAt: number | null,
  now: number
): string | null {
  if (startedAt === null) return null;
  const seconds = Math.max(0, Math.floor(((endedAt ?? now) - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours
    ? `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export const stallTextKey = "agentJobs.pane.stallWarning";

export function authStateKey(state: "authenticated" | "not_authenticated" | "unknown"): string {
  return `agentJobs.pane.auth.${state}`;
}

export function failureMessage(reason: string | null): { key: string } | { text: string } {
  if (reason === "not_authenticated") return { key: "agentJobs.pane.failure.notAuthenticated" };
  if (reason === "interrupted") return { key: "agentJobs.pane.failure.interrupted" };
  if (reason === "cancelled") return { key: "agentJobs.pane.failure.cancelled" };
  return reason ? { text: reason } : { key: "agentJobs.toast.unknownError" };
}
