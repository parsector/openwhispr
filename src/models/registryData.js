import bundledCatalog from "./modelRegistryData.json" with { type: "json" };
import { withAppTranscriptionProviders } from "./appTranscriptionProviders.js";

// The catalog this build ships. Main's registry loader starts from it too.
const bundled = withAppTranscriptionProviders(bundledCatalog);
export { bundled as bundledRegistryData };

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// Lifecycle metadata is descriptive only in this fork.
function splitRetired(catalog) {
  const visible = structuredClone(catalog);
  for (const section of [
    "cloudProviders",
    "enterpriseProviders",
    "transcriptionProviders",
    "localProviders",
  ]) {
    visible[section] = Array.isArray(visible[section]) ? visible[section].filter(Boolean) : [];
    for (const provider of visible[section])
      provider.models = Array.isArray(provider.models) ? provider.models : [];
  }
  for (const section of ["whisperModels", "parakeetModels"])
    if (
      !visible[section] ||
      typeof visible[section] !== "object" ||
      Array.isArray(visible[section])
    )
      visible[section] = {};
  return { visible };
}

// A stable top-level reference keeps existing CJS and ESM readers live. Each
// replacement owns immutable child objects, so in-flight work keeps its config.
// Until main applies its static catalog (before any window opens, and to the
// renderer through preload), this holds the bundled data at version -1.
const initial = splitRetired(bundled);
export const registryData = { ...freeze(initial.visible) };
let snapshotData = bundled;
let version = -1;
let pending = false;
const listeners = new Set();
export const getRegistryData = () => registryData;
export const getRegistryVersion = () => version;
// The full fork-owned catalog.
export const getRegistrySnapshot = () => ({
  data: structuredClone(snapshotData),
  manifestVersion: version,
  pending,
});
// A catalog this app accepted before could not be loaded yet (see registryLoader).
export const isCatalogPending = () => pending;
export const getRetiredModel = (_section, _providerId, _modelId) => undefined;
export const listRetiredModels = () => [];
// Every shipped or restored installed entry remains runnable.
export const getRunnableSpeechModel = (section, modelId) =>
  Object.hasOwn(registryData[section], modelId) ? registryData[section][modelId] : null;
export const listRunnableLocalModels = (section) =>
  section === "localProviders"
    ? registryData.localProviders.flatMap((provider) =>
        provider.models.map((model) => [model.id, model])
      )
    : Object.entries(registryData[section]);
export function subscribeRegistry(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Only the verified main loader and its preload/IPC mirror call this boundary.
// Main supplies the build catalog plus trusted installed model descriptions.
export function replaceRegistryData(snapshot) {
  // The one change at the same version: a catalog that was pending has settled. Subscribers
  // run again, so the repairs it held back happen now.
  const settles = snapshot?.manifestVersion === version && pending && snapshot.pending !== true;
  if (
    !Number.isSafeInteger(snapshot?.manifestVersion) ||
    (snapshot.manifestVersion <= version && !settles)
  )
    return false;
  if (!snapshot.data || Object.keys(bundled).some((key) => !Object.hasOwn(snapshot.data, key)))
    return false;
  const next = splitRetired(snapshot.data);
  snapshotData = freeze(structuredClone(snapshot.data));
  Object.assign(registryData, freeze(next.visible));
  version = snapshot.manifestVersion;
  pending = snapshot.pending === true;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error("Model registry subscriber failed", error);
    }
  }
  return true;
}
