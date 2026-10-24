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

export function guaranteeKey(harness: string, mode?: string): string {
  if (mode === "write") return "agentJobs.guarantee.write";
  return harness === "cursor-agent"
    ? "agentJobs.guarantee.bestEffort"
    : "agentJobs.guarantee.enforced";
}

export function authStateKey(
  state: "authenticated" | "not_authenticated" | "unknown",
  method: string | null = null,
  harness: "claude" | "cursor-agent" = "claude"
): string {
  if (state === "not_authenticated" && harness === "cursor-agent")
    return "agentJobs.pane.auth.cursorNotAuthenticated";
  if (state !== "authenticated") return `agentJobs.pane.auth.${state}`;
  if (method === "claude.ai") return "agentJobs.pane.auth.subscription";
  if (method === "api_key" || method === "api_key_helper") return "agentJobs.pane.auth.apiKey";
  if (method === "oauth_token") return "agentJobs.pane.auth.oauthToken";
  return method && method !== "third_party"
    ? "agentJobs.pane.auth.otherMethod"
    : "agentJobs.pane.auth.authenticated";
}

export const lastErrorKey = "agentJobs.pane.failure.lastError";

export function failureDescription(
  reason: string | null,
  lastError: string | null | undefined,
  translate: (key: string) => string,
  harness: string = "claude",
  worktree?: { branch?: string; worktreePath?: string; worktreeCreated?: boolean; discardedAt?: number }
): string {
  const message = failureMessage(reason, harness);
  const reasonText = "key" in message ? translate(message.key) : message.text;
  const detail = lastError ? `${reasonText}\n${translate(lastErrorKey)}: ${lastError}` : reasonText;
  return worktree?.worktreePath && worktree.worktreeCreated && !worktree.discardedAt
    ? `${detail}\n${translate("agentJobs.pane.worktreeKept")}: ${worktree.worktreePath} (${worktree.branch})`
    : detail;
}

export function failureMessage(
  reason: string | null,
  harness: string = "claude"
): { key: string } | { text: string } {
  if (reason === "not_authenticated")
    return {
      key:
        harness === "cursor-agent"
          ? "agentJobs.pane.auth.cursorNotAuthenticated"
          : "agentJobs.pane.failure.notAuthenticated",
    };
  if (reason === "interrupted") return { key: "agentJobs.pane.failure.interrupted" };
  if (reason === "cancelled") return { key: "agentJobs.pane.failure.cancelled" };
  return reason ? { text: reason } : { key: "agentJobs.toast.unknownError" };
}
