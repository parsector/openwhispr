import i18n from "../../i18n";
import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { addLocalApproval } from "../../stores/localApprovalStore";

export const resumeAgentJobTool: ToolDefinition = {
  name: "resume_agent_job",
  description: i18n.t("agentJobs.tools.resumeDescription"),
  promptInstruction: i18n.t("agentJobs.tools.resumeInstruction"),
  parameters: {
    type: "object",
    properties: { jobId: { type: "string" }, task: { type: "string" } },
    required: ["jobId", "task"],
    additionalProperties: false,
  },
  readOnly: false,
  async execute(args, context): Promise<ToolResult> {
    if (typeof args.jobId !== "string" || !args.jobId.trim())
      return { success: false, data: null, displayText: i18n.t("agentJobs.tools.unknownJob") };
    if (typeof args.task !== "string" || !args.task.trim())
      return { success: false, data: null, displayText: i18n.t("agentJobs.tools.invalidTask") };
    if (!context)
      return { success: false, data: null, displayText: i18n.t("agentJobs.tools.unavailable") };
    const parent = await window.agentJobs.get(args.jobId);
    if (!parent)
      return { success: false, data: null, displayText: i18n.t("agentJobs.tools.unknownJob") };
    if (!context.claimTurnSlot("agent_job", 2))
      return { success: false, data: null, displayText: i18n.t("agentJobs.tools.limit") };
    try {
      const job = await window.agentJobs.prepare({
        resumeJobId: parent.jobId,
        task: args.task,
        ...(context.origin ? { origin: context.origin } : {}),
      });
      const action = job.prompt.replace(/\s+/g, " ").slice(0, 120);
      const summary = `harness ${job.harness} on repo ${job.project.name} with model ${job.model || "default"} for action ${action}`;
      addLocalApproval(context, job, summary);
      context.onApprovalRequested();
      context.onHoldDelivery();
      return {
        success: true,
        data: { jobId: job.jobId, status: "awaiting_approval", summary },
        displayText: summary,
      };
    } catch (error) {
      context.releaseTurnSlot("agent_job");
      return { success: false, data: null, displayText: (error as Error).message };
    }
  },
};
