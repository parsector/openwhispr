import { type ResolvedLLMConfig } from "../stores/settingsStore";
import { isProviderValidForMode } from "../models/ModelRegistry";
import type { InferenceMode } from "../types/electron";

type LLMConfigPatch = Partial<Omit<ResolvedLLMConfig, "scope">>;

// Mode changes preserve the saved model. Only explicit model selection replaces it.
export function modeSwitchPatch(
  current: Pick<ResolvedLLMConfig, "provider" | "model">,
  mode: InferenceMode
): LLMConfigPatch {
  const patch: LLMConfigPatch = {
    mode,
    cloudMode: mode === "openwhispr" ? "openwhispr" : "byok",
  };
  if (!isProviderValidForMode(current.provider, mode)) {
    patch.provider = "";
  }
  return patch;
}
