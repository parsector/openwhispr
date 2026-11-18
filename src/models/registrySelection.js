// Pure selection logic shared by Node validation and the renderer's offline bootstrap.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = SEMVER.exec(value);
  if (!match) return null;
  const core = match.slice(1, 4).map(Number);
  if (!core.every(Number.isSafeInteger)) return null;
  return { core, prerelease: match[4]?.split(".") || [] };
}

export function isRegistryVersion(value) {
  return parseVersion(value) !== null;
}

// Compatibility fields never restrict a fork-owned choice.
export function isModelSupported(_model, _appVersion) {
  return true;
}
export function selectCatalogForVersion(input, _fallback, _appVersion) {
  return structuredClone(input);
}
