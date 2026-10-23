import { isEnterpriseProvider } from "../../models/ModelRegistry";

const TOOL_RESULT_SHARE = 0.05; // Target 5% of the model window for one result, then clamp.
const CHARS_PER_TOKEN = 4; // Conservative planning conversion, not tokenization.
const MIN_RESULT_CHARS = 8_000;
const MAX_RESULT_CHARS = 256_000;
const LOCAL_FALLBACK_TOKENS = 16_384;

// Conservative provider planning defaults, not guarantees for every model. The 5% share
// and 256k ceiling keep an over-estimate survivable until model-specific metadata is available.
const CLOUD_CONTEXT_TOKENS: Record<string, number> = {
  openai: 400_000,
  anthropic: 200_000,
  gemini: 1_000_000,
  openrouter: 128_000,
  groq: 128_000,
  tinfoil: 32_768,
  corti: 16_384,
  custom: 32_768,
};
const DEFAULT_CONTEXT_TOKENS = 32_768;
const warnedModels = new Set<string>();

export function mcpResultBudgetChars(contextTokens: number): number {
  return Math.round(
    Math.min(
      MAX_RESULT_CHARS,
      Math.max(MIN_RESULT_CHARS, contextTokens * TOOL_RESULT_SHARE * CHARS_PER_TOKEN)
    )
  );
}

export function isLocalMcpProvider(provider: string): boolean {
  return !isEnterpriseProvider(provider) && !Object.hasOwn(CLOUD_CONTEXT_TOKENS, provider);
}

export async function resolveMcpResultBudget(
  provider: string,
  modelId: string,
  isLocalProvider: boolean,
  lookup: (modelId: string) => Promise<{ success: boolean; maxContextTokens?: number }>,
  log: (message: string) => void = console.warn
): Promise<number> {
  if (!isLocalProvider)
    return mcpResultBudgetChars(CLOUD_CONTEXT_TOKENS[provider] ?? DEFAULT_CONTEXT_TOKENS);
  try {
    const result = await lookup(modelId);
    if (result.success && Number.isFinite(result.maxContextTokens) && result.maxContextTokens! > 0)
      return mcpResultBudgetChars(result.maxContextTokens!);
  } catch {
    // A missing or failed IPC lookup uses the same bounded local fallback.
  }
  if (!warnedModels.has(modelId)) {
    warnedModels.add(modelId);
    log(`MCP result budget: local context lookup failed for ${modelId}; using 16,384 tokens`);
  }
  return mcpResultBudgetChars(LOCAL_FALLBACK_TOKENS);
}
