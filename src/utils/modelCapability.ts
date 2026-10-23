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
