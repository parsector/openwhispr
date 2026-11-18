// Compatibility functions for existing dispatchers. The fork never rewrites a
// user's model because a provider changed its discovery list.
export const RETIRED_CLOUD_MODELS = {};
export const RETIRED_TINFOIL_MODEL_NAMES = {};
export function resolveRetiredCloudModel(_provider, model) {
  return model;
}
export function isSelectableTinfoilModel(_model) {
  return true;
}
