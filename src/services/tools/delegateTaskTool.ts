import i18n from "../../i18n";
import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { addLocalApproval } from "../../stores/localApprovalStore";

export interface AgentProject {
  name: string;
  defaultHarness: "claude" | "cursor-agent";
  model: string | null;
}

export function createDelegateTaskTool(projects: AgentProject[]): ToolDefinition {
  return {
    name: "delegate_task",
    description: i18n.t("agentJobs.tools.delegateDescription"),
    promptInstruction: i18n.t("agentJobs.tools.delegateInstruction"),
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", enum: projects.map((project) => project.name) },
        task: { type: "string" },
        harness: { type: "string", enum: ["claude", "cursor-agent"] },
        model: { type: "string" },
      },
      required: ["project", "task"],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(args, context): Promise<ToolResult> {
      const project = projects.find((item) => item.name === args.project);
      if (!project)
        return {
          success: false,
          data: null,
          displayText: i18n.t("agentJobs.tools.unknownProject"),
        };
      if (typeof args.task !== "string" || !args.task.trim())
        return { success: false, data: null, displayText: i18n.t("agentJobs.tools.invalidTask") };
      if (!context)
        return { success: false, data: null, displayText: i18n.t("agentJobs.tools.unavailable") };
      if (!context.claimTurnSlot("agent_job", 2))
        return { success: false, data: null, displayText: i18n.t("agentJobs.tools.limit") };
      try {
        const job = await window.agentJobs.prepare({
          project: project.name,
          task: args.task,
          ...(context.origin ? { origin: context.origin } : {}),
          ...(args.harness === undefined
            ? {}
            : { harness: args.harness as "claude" | "cursor-agent" }),
          ...(args.model === undefined ? {} : { model: args.model as string }),
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
        const message = (error as Error).message;
        return {
          success: false,
          data: null,
          displayText: message.includes("not_authenticated")
            ? `not_authenticated: Sign in to ${project.defaultHarness === "claude" ? "Claude" : "Cursor"} and try again.`
            : message,
        };
      }
    },
  };
}
