// Compatibility seam: saved and typed model choices are never migrated.
export { RETIRED_CLOUD_MODELS } from "./retiredCloudModelPolicy.js";
export type RetiredModelProvider = "groq" | "tinfoil" | "openai";
export interface SweptModelSelection {
  storeKey: string;
  provider: RetiredModelProvider;
  from: string;
  to: string;
}
export function sweepRetiredCloudModelSelections(
  _storage: { getItem(key: string): string | null; setItem(key: string, value: string): void },
  _scopes: readonly { provider: string; model: string }[]
): SweptModelSelection[] {
  return [];
}
