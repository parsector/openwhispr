import type { ResolvedLLMConfig } from "../../stores/settingsStore";

/** The non-secret settings main needs for unattended runs, including cold starts. */
export function routineModelChoice(
  config: ResolvedLLMConfig,
  chat: ResolvedLLMConfig,
  hasRoutineOverride = false
) {
  const safeUrl = (raw?: string) => {
    if (!raw) return "";
    try {
      const endpoint = new URL(raw);
      if (!endpoint.username && !endpoint.password && /^https?:$/.test(endpoint.protocol)) {
        endpoint.hash = "";
        return endpoint.toString().replace(/\/$/, "");
      }
    } catch {}
    return "";
  };
  const remoteUrl = safeUrl(config.remoteUrl);
  const cloudBaseUrl = safeUrl(config.cloudBaseUrl);
  const chosenEndpoint =
    config.mode === "self-hosted"
      ? remoteUrl
      : config.mode === "providers" && config.provider === "custom"
        ? cloudBaseUrl
        : "";
  const chatEndpoint =
    chat.mode === "self-hosted"
      ? safeUrl(chat.remoteUrl)
      : chat.mode === "providers" && chat.provider === "custom"
        ? safeUrl(chat.cloudBaseUrl)
        : "";
  const useRoutinesEndpointKey =
    hasRoutineOverride && chosenEndpoint !== "" && Boolean(config.customApiKey);
  return {
    mode: config.mode,
    provider: config.provider,
    model: config.model,
    remoteUrl,
    cloudBaseUrl,
    useChatEndpointKey:
      !useRoutinesEndpointKey && chosenEndpoint !== "" && chosenEndpoint === chatEndpoint,
    useRoutinesEndpointKey,
  };
}
