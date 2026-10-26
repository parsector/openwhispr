function routineCustomEndpoint(choice) {
  const baseUrl =
    choice?.mode === "self-hosted"
      ? choice.remoteUrl
      : choice?.mode === "providers" && choice.provider === "custom"
        ? choice.cloudBaseUrl || choice.remoteUrl
        : "";
  if (!/^https?:\/\//.test(baseUrl || "")) return null;
  let completionsUrl;
  try {
    const endpoint = new URL(baseUrl);
    if (endpoint.username || endpoint.password) return null;
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/chat/completions`;
    endpoint.hash = "";
    completionsUrl = endpoint.toString();
  } catch {
    return null;
  }
  return {
    baseUrl,
    completionsUrl,
  };
}

module.exports = { routineCustomEndpoint };
