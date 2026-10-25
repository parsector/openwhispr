const LOCAL_TOOL_MIN_PARAMS_B = 4;

export function estimateModelSizeB(modelId: string): number | null {
  const match = modelId.match(/(?:^|[:-])(\d+(?:\.\d+)?)[bB](?=$|[:-])/);
  return match ? Number(match[1]) : null;
}

export function modelSupportsToolCalls(modelId: string): boolean {
  if (/-cloud$/i.test(modelId)) return true;
  const sizeB = estimateModelSizeB(modelId);
  return sizeB === null || sizeB >= LOCAL_TOOL_MIN_PARAMS_B;
}

/** Capability of the endpoint actually used by an unattended routine. */
export function routineEndpointSupportsTools(
  choice:
    | {
        mode: string;
        provider: string;
        model: string;
      }
    | null
    | undefined
): boolean {
  if (!choice?.model) return false;
  if (choice.mode === "openwhispr") return false; // /api/reason has no tool loop
  if (choice.mode === "local") return modelSupportsToolCalls(choice.model);
  return ["providers", "self-hosted", "enterprise"].includes(choice.mode);
}
