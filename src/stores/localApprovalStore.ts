import { create } from "zustand";
import type { ToolExecutionContext } from "../services/tools/ToolRegistry";
import { approvalKey } from "./connectorApprovalStore";

export interface LocalApprovalEntry {
  key: string;
  messageId: string;
  toolCallId: string;
  jobId: string;
  harness: string;
  mode?: string;
  summary: string;
  prompt: string;
  state: "pending" | "approving" | "cancelling" | "started" | "failed" | "cancelled";
  error?: string;
}

export const useLocalApprovalStore = create<{
  entries: Record<string, LocalApprovalEntry>;
  receipts: Record<string, LocalApprovalEntry>;
}>(() => ({ entries: {}, receipts: {} }));

function patch(key: string, changes: Partial<LocalApprovalEntry>): void {
  useLocalApprovalStore.setState((store) => {
    const entry = store.entries[key];
    return entry ? { entries: { ...store.entries, [key]: { ...entry, ...changes } } } : store;
  });
}

function clearAfterReceipt(key: string): void {
  const timer = setTimeout(() => {
    useLocalApprovalStore.setState((store) => {
      if (!store.receipts[key]) return store;
      const receipts = { ...store.receipts };
      delete receipts[key];
      return { receipts };
    });
  }, 10_000);
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
}

function finish(key: string, changes: Partial<LocalApprovalEntry>): void {
  useLocalApprovalStore.setState((store) => {
    const entry = store.entries[key] ?? store.receipts[key];
    if (!entry) return store;
    const entries = { ...store.entries };
    delete entries[key];
    return { entries, receipts: { ...store.receipts, [key]: { ...entry, ...changes } } };
  });
  clearAfterReceipt(key);
}

export function addLocalApproval(
  context: ToolExecutionContext,
  job: { jobId: string; prompt: string; harness: string; mode?: string },
  summary: string
): void {
  const key = approvalKey(context.messageId, context.toolCallId);
  const entry: LocalApprovalEntry = {
    key,
    messageId: context.messageId,
    toolCallId: context.toolCallId,
    jobId: job.jobId,
    harness: job.harness,
    mode: job.mode,
    summary,
    prompt: job.prompt,
    state: "pending",
  };
  useLocalApprovalStore.setState((store) => ({
    entries: { ...store.entries, [key]: entry },
  }));
}

export function updateLocalPrompt(key: string, prompt: string): void {
  const entry = useLocalApprovalStore.getState().entries[key];
  if (entry?.state === "pending") patch(key, { prompt });
}

export async function approveLocal(key: string): Promise<void> {
  const entry = useLocalApprovalStore.getState().entries[key];
  if (entry?.state !== "pending") return;
  patch(key, { state: "approving", error: undefined });
  try {
    const job = await window.agentJobs.approve(entry.jobId, { prompt: entry.prompt });
    finish(key, {
      state: job.status === "failed" ? "failed" : "started",
      error: job.reason ?? undefined,
    });
  } catch (error) {
    finish(key, { state: "failed", error: (error as Error).message });
  }
}

export async function cancelLocal(key: string): Promise<void> {
  const entry = useLocalApprovalStore.getState().entries[key];
  if (entry?.state !== "pending") return;
  patch(key, { state: "cancelling", error: undefined });
  try {
    await window.agentJobs.cancel(entry.jobId);
    finish(key, { state: "cancelled" });
  } catch (error) {
    finish(key, { state: "failed", error: (error as Error).message });
  }
}

export function updateLocalApprovalJob(job: {
  jobId: string;
  status: string;
  reason: string | null;
}): void {
  const store = useLocalApprovalStore.getState();
  for (const entry of [...Object.values(store.entries), ...Object.values(store.receipts)]) {
    if (entry.jobId !== job.jobId || entry.state === "cancelled") continue;
    if (job.status === "failed") {
      finish(entry.key, { state: "failed", error: job.reason ?? undefined });
    } else if (job.status === "cancelled") {
      finish(entry.key, { state: "cancelled" });
    } else if (["queued", "running", "done"].includes(job.status))
      finish(entry.key, { state: "started" });
  }
}
