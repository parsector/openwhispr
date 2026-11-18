import {
  applyTinfoilModels,
  getCloudProviderDefaultModelId,
  type CloudModelDefinition,
} from "./ModelRegistry";
import { pickProviderDefaultModel } from "./providerDefaultModel";
import {
  isCachedListFresh,
  readCachedTinfoilModels,
  writeCachedTinfoilModels,
} from "./tinfoilModelCache";

/** A chat model as reported by Tinfoil's /v1/models, narrowed by the main process. */
export interface TinfoilCatalogModel {
  id: string;
  name: string;
  description: string;
  supportsThinking: boolean;
}

/**
 * Curated, translated descriptions keyed by model id. The endpoint only returns
 * English copy.
 */
export const DESCRIPTION_KEYS: Record<string, string> = {
  "glm-5-3": "models.descriptions.cloud.tinfoil_glm_5_3",
  "gemma4-31b": "models.descriptions.cloud.tinfoil_gemma4_31b",
  "gpt-oss-120b": "models.descriptions.cloud.tinfoil_gpt_oss_120b",
  "llama3-3-70b": "models.descriptions.cloud.tinfoil_llama3_3_70b",
  "kimi-k3": "models.descriptions.cloud.tinfoil_kimi_k3",
  "deepseek-v4-1-flash": "models.descriptions.cloud.tinfoil_deepseek_v4_1_flash",
};

function toCloudModels(catalog: TinfoilCatalogModel[]): CloudModelDefinition[] {
  return catalog.map((model) => ({
    id: model.id,
    name: model.name,
    description: model.description,
    descriptionKey: DESCRIPTION_KEYS[model.id],
    supportsThinking: model.supportsThinking,
    tokenParam: "max_tokens",
    supportsTemperature: true,
  }));
}

export function pickDefaultTinfoilModel(
  models: CloudModelDefinition[]
): CloudModelDefinition | undefined {
  return pickProviderDefaultModel(models, getCloudProviderDefaultModelId("tinfoil"));
}

let inFlight: Promise<CloudModelDefinition[]> | null = null;

async function fetchAndApply(): Promise<CloudModelDefinition[]> {
  const fetchModels = window.electronAPI?.getTinfoilChatModels;
  if (!fetchModels) {
    throw new Error("Tinfoil model list is unavailable");
  }

  const models = toCloudModels(await fetchModels());
  if (models.length === 0) {
    // Far more likely something upstream broke, so keep what we already have.
    throw new Error("Tinfoil returned no chat models");
  }

  applyTinfoilModels(models);
  writeCachedTinfoilModels(models);
  return models;
}

/** Whether refreshTinfoilModels would hit the network rather than short-circuit. */
export function isTinfoilListFresh(): boolean {
  return isCachedListFresh(readCachedTinfoilModels());
}

/**
 * Pulls Tinfoil's model list into the registry, at most once an hour. Cheap to
 * call before every request: a list we fetched recently short-circuits without
 * touching the network, and the timestamp is persisted so a restart doesn't
 * refetch a list we pulled a minute ago. Rejects when Tinfoil can't be reached,
 * leaving the registry as it was.
 */
export function refreshTinfoilModels(): Promise<CloudModelDefinition[]> {
  const cached = readCachedTinfoilModels();
  if (isCachedListFresh(cached)) {
    // Another window may have fetched this; make sure our registry has it too.
    applyTinfoilModels(cached.models);
    return Promise.resolve(cached.models);
  }

  if (!inFlight) {
    inFlight = fetchAndApply().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
