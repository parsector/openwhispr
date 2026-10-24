import type { AgentJob } from "../../types/electron";
import { failureDescription } from "../../components/integrations/agentJobsPresentation";

const TRUNCATION = "… [truncated — full result in the note]";

export function jobMessageId(jobId: string): string {
  return `job-${jobId}`;
}

export function jobDeliveryText(job: AgentJob, translate: (key: string) => string): string | null {
  if (job.status === "failed")
    return failureDescription(job.reason, job.lastError, translate, job.harness);
  if (job.status !== "done") return null;
  const answer = job.result ?? "";
  const characters = Array.from(answer);
  const capped =
    characters.length > 6000
      ? `${characters.slice(0, 6000 - TRUNCATION.length).join("")}${TRUNCATION}`
      : answer;
  const duration =
    job.startedAt == null || job.endedAt == null
      ? "unknown"
      : `${Math.max(0, Math.round((job.endedAt - job.startedAt) / 1000))}s`;
  const footer = `Note: Agent job: ${job.project.name} (id ${job.noteId ?? "unknown"}) · Duration: ${duration}${job.branch ? ` · Branch: ${job.branch}` : ""}`;
  return `${capped}\n\n${footer}`;
}

export async function deliverJobMessage(
  job: AgentJob,
  translate: (key: string) => string,
  append: (
    conversationId: number,
    role: "assistant",
    content: string,
    metadata: Record<string, unknown>
  ) => Promise<unknown>
): Promise<boolean> {
  if (!job.origin) return false;
  const content = jobDeliveryText(job, translate);
  if (content === null) return false;
  const conversationId = Number(job.origin.conversationId);
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0) return false;
  try {
    return Boolean(
      await append(conversationId, "assistant", content, {
        messageId: jobMessageId(job.jobId),
        jobId: job.jobId,
        origin: job.origin,
      })
    );
  } catch {
    return false;
  }
}
