import i18n from "../../i18n";
import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { addLocalApproval } from "../../stores/localApprovalStore";
import { resolvePresetPrompt } from "../agents/presetPlaceholders.mjs";

export interface AgentPreset {
  id: string;
  name: string;
  project: string;
  harness: "claude" | "cursor-agent";
  model: string | null;
  mode: "read-only" | "write" | "plan" | "ask";
  prompt: string;
  description: string;
}

export function createRunPresetTool(presets: AgentPreset[]): ToolDefinition {
  return {
    name: "run_preset",
    description: i18n.t("agentJobs.tools.presetDescription"),
    promptInstruction: i18n.t("agentJobs.tools.presetInstruction"),
    parameters: {
      type: "object",
      properties: {
        preset: { type: "string", enum: presets.map((item) => item.name) },
        values: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["preset"],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(args, context): Promise<ToolResult> {
      const preset = presets.find((item) => item.name === args.preset);
      if (!preset)
        return { success: false, data: null, displayText: i18n.t("agentJobs.tools.unknownPreset") };
      if (!context)
        return { success: false, data: null, displayText: i18n.t("agentJobs.tools.unavailable") };
      let prompt: string;
      try {
        prompt = resolvePresetPrompt(preset.prompt, args.values ?? {});
      } catch (error) {
        return { success: false, data: null, displayText: (error as Error).message };
      }
      if (!context.claimTurnSlot("agent_job", 2))
        return { success: false, data: null, displayText: i18n.t("agentJobs.tools.limit") };
      try {
        const job = await window.agentJobs.prepare({
          project: preset.project,
          task: prompt,
          ...(context.origin ? { origin: context.origin } : {}),
          harness: preset.harness,
          mode: preset.mode,
          ...(preset.model ? { model: preset.model } : {}),
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
}
