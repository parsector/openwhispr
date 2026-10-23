import i18n from "../../i18n";
import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { UNTRUSTED_GUIDANCE } from "./connectors/runQueryAction";

export const agentJobTool: ToolDefinition = {
  name: "get_agent_job",
  description: i18n.t("agentJobs.tools.getDescription"),
  promptInstruction: i18n.t("agentJobs.tools.getInstruction"),
  parameters: {
    type: "object",
    properties: { jobId: { type: "string" } },
    additionalProperties: false,
  },
  readOnly: true,
  async execute(args, context): Promise<ToolResult> {
    try {
      const data =
        typeof args.jobId === "string"
          ? await window.agentJobs.get(args.jobId)
          : await window.agentJobs.list();
      if (!data)
        return { success: false, data: null, displayText: i18n.t("agentJobs.tools.unknownJob") };
      const items = Array.isArray(data)
        ? data
            .slice(-20)
            .reverse()
            .map((job) => ({
              jobId: job.jobId,
              status: job.status,
              project: job.project.name,
              harness: job.harness,
              started: job.startedAt,
              duration: job.startedAt === null ? null : (job.endedAt ?? Date.now()) - job.startedAt,
              summary: job.prompt.replace(/\s+/g, " ").slice(0, 120),
            }))
        : {
            jobId: data.jobId,
            status: data.status,
            project: data.project.name,
            harness: data.harness,
            steps: data.steps.slice(-20),
            result: data.result,
            reason: data.reason,
          };
      const text = context?.limitMcpResult?.(JSON.stringify(items)) ?? JSON.stringify(items);
      const result = {
        status: "ok",
        source: "agent_job",
        untrusted: true,
        items: text,
        truncated: text.includes("[truncated"),
        guidance: UNTRUSTED_GUIDANCE,
      };
      return { success: true, data: result, displayText: i18n.t("agentJobs.tools.results") };
    } catch (error) {
      return { success: false, data: null, displayText: (error as Error).message };
    }
  },
};
