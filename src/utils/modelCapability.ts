const LOCAL_TOOL_MIN_PARAMS_B = 4;

export function estimateModelSizeB(modelId: string): number | null {
  const match =
    typeof modelId === "string" ? modelId.match(/(?:^|[:-])(\d+(?:\.\d+)?)[bB](?=$|[:-])/) : null;
  return match ? Number(match[1]) : null;
}

export function modelSupportsToolCalls(modelId: string): boolean {
  if (/-cloud$/i.test(String(modelId ?? ""))) return true;
  const sizeB = estimateModelSizeB(modelId);
  return sizeB === null || sizeB >= LOCAL_TOOL_MIN_PARAMS_B;
}

export interface ToolEndpointChoice {
  mode: string;
  provider: string;
  model: string;
  remoteUrl?: string;
  cloudBaseUrl?: string;
  supportsToolCalls?: boolean;
}

/** Stable identity for a user-configured endpoint and its selected model. */
export function toolEndpointKey(
  choice: ToolEndpointChoice | null | undefined,
  enterpriseEndpoint = ""
): string | null {
  if (
    !choice ||
    typeof choice.model !== "string" ||
    typeof choice.mode !== "string" ||
    typeof choice.provider !== "string"
  )
    return null;
  const endpoint =
    choice.mode === "self-hosted"
      ? choice.remoteUrl
      : choice.mode === "enterprise"
        ? enterpriseEndpoint
        : choice.mode === "providers" && choice.provider === "custom"
          ? choice.cloudBaseUrl
          : null;
  if (endpoint === null || !choice.model) return null;
  return JSON.stringify([
    choice.mode,
    choice.provider,
    (typeof endpoint === "string" ? endpoint : "").trim(),
    choice.model,
  ]);
}

/** Only managed local models use the parameter-count heuristic. */
export function endpointSupportsToolCalls(choice: ToolEndpointChoice | null | undefined): boolean {
  if (!choice?.model) return true;
  if (choice.mode === "local") {
    return modelSupportsToolCalls(choice.model);
  }
  if (toolEndpointKey(choice) !== null) return choice.supportsToolCalls !== false;
  return true;
}

/** Capability of the endpoint actually used by an unattended routine. */
export function routineEndpointSupportsTools(
  choice:
    | {
        mode: string;
        provider: string;
        model: string;
        supportsToolCalls?: boolean;
      }
    | null
    | undefined
): boolean {
  if (!choice?.model) return true;
  if (choice.mode === "openwhispr") return false; // /api/reason has no tool loop
  if (!["providers", "self-hosted", "enterprise", "local"].includes(choice.mode)) return true;
  return endpointSupportsToolCalls(choice);
}
