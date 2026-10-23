import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";
import { RESULT_SIZE_OPTIONS, type McpServerInfo } from "../../services/tools/mcpTools";
import { isLocalMcpProvider, resolveMcpResultBudget } from "../../services/tools/mcpResultBudget";
import { resolveChatStreamingInference } from "../../helpers/dictationAgentInference.js";
import { useSettingsStore } from "../../stores/settingsStore";

export function McpServers(): ReactElement {
  const { t } = useTranslation();
  const settings = useSettingsStore();
  const { provider, model, mode: llmMode } = resolveChatStreamingInference(settings).config;
  const [modelBudget, setModelBudget] = useState(8_000);
  useEffect(() => {
    let active = true;
    void resolveMcpResultBudget(
      provider,
      model,
      isLocalMcpProvider(provider) && !(llmMode === "openwhispr" && settings.isSignedIn),
      (modelId) => window.electronAPI.getLocalContextBudget(modelId)
    ).then((budget) => {
      if (active) setModelBudget(budget);
    });
    return () => {
      active = false;
    };
  }, [provider, model, llmMode, settings.isSignedIn]);
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [name, setName] = useState("");
  const [raw, setRaw] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [cwd, setCwd] = useState("");
  const [env, setEnv] = useState("");
  const [headers, setHeaders] = useState("");
  const [secretFields, setSecretFields] = useState("");
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"form" | "json">("form");
  const refresh = useCallback(async () => {
    try {
      setServers((await window.mcpClient.list()).servers);
    } catch (reason) {
      setError((reason as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  const run = async (task: () => Promise<unknown>): Promise<void> => {
    try {
      setError("");
      await task();
      await refresh();
    } catch (reason) {
      setError((reason as Error).message);
    }
  };
  const save = async (): Promise<void> => {
    await run(async () => {
      let serverName = name.trim();
      let config: Record<string, unknown>;
      if (mode === "json") {
        const parsed = JSON.parse(raw) as { mcpServers?: Record<string, Record<string, unknown>> };
        if (!parsed.mcpServers || Object.keys(parsed.mcpServers).length !== 1)
          throw new Error(t("integrations.mcp.servers.oneServer"));
        [serverName, config] = Object.entries(parsed.mcpServers)[0];
      } else {
        config = url.trim()
          ? {
              type: "http",
              url: url.trim(),
              ...(headers.trim() ? { headers: JSON.parse(headers) as Record<string, string> } : {}),
            }
          : {
              command: command.trim(),
              args: args.trim() ? (JSON.parse(args) as string[]) : [],
              ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
              ...(env.trim() ? { env: JSON.parse(env) as Record<string, string> } : {}),
            };
      }
      const secrets: Record<string, string> = {};
      if (secretFields.trim()) {
        for (const [field, value] of Object.entries(
          JSON.parse(secretFields) as Record<string, string>
        ))
          secrets[field] = value;
      }
      await window.mcpClient.upsert(serverName, config, { secrets });
      setName("");
      setRaw("");
      setCommand("");
      setArgs("");
      setUrl("");
      setCwd("");
      setEnv("");
      setHeaders("");
      setSecretFields("");
    });
  };
  const confirm = (server: McpServerInfo): void => {
    const config = server.config;
    const details = { command: config.command, args: config.args || [], cwd: config.cwd || null };
    void run(() => window.mcpClient.confirm(server.name, details));
  };
  const edit = (server: McpServerInfo): void => {
    setMode("json");
    setRaw(JSON.stringify({ mcpServers: { [server.name]: server.config } }, null, 2));
    setName(server.name);
  };
  return (
    <SettingsPanel>
      <SettingsPanelRow>
        <h3 className="text-sm font-semibold">{t("integrations.mcp.servers.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("integrations.mcp.servers.description")}</p>
      </SettingsPanelRow>
      {servers.map((server) => (
        <SettingsPanelRow key={server.name}>
          <div className="flex items-center gap-2 text-sm">
            <span
              aria-label={server.status}
              className={`h-2 w-2 rounded-full ${server.status === "connected" ? "bg-green-500" : server.status === "error" ? "bg-red-500" : "bg-muted-foreground"}`}
            />
            <strong>{server.name}</strong>
            <span className="text-xs text-muted-foreground">{server.status}</span>
          </div>
          {server.lastError && (
            <p role="alert" className="text-xs text-destructive">
              {server.lastError}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-2">
              <span>{t("integrations.mcp.servers.resultSize")}</span>
              <select
                className="rounded border bg-background px-2 py-1"
                value={server.maxResultChars ?? ""}
                onChange={(event) =>
                  void run(() =>
                    window.mcpClient.resultSize(
                      server.name,
                      event.target.value ? Number(event.target.value) : null
                    )
                  )
                }
              >
                <option value="">{t("integrations.mcp.servers.modelDefault")}</option>
                {RESULT_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size / 1_000}k
                  </option>
                ))}
              </select>
              {server.maxResultChars !== undefined && server.maxResultChars > modelBudget && (
                <span className="text-muted-foreground">
                  {t("integrations.mcp.servers.modelClamp", { size: `${modelBudget / 1_000}k` })}
                </span>
              )}
            </label>
            <label>
              <input
                type="checkbox"
                checked={server.enabled}
                onChange={(event) =>
                  void run(() => window.mcpClient.enable(server.name, event.target.checked))
                }
              />{" "}
              {t("integrations.mcp.servers.enabled")}
            </label>
            <label>
              <input
                type="checkbox"
                checked={server.allowWithoutAsking}
                onChange={(event) =>
                  void run(() => window.mcpClient.allow(server.name, event.target.checked))
                }
              />{" "}
              {t("integrations.mcp.servers.allowWithoutAsking")}
            </label>
            {!server.confirmed && server.config.type !== "http" && (
              <Button type="button" variant="outline" onClick={() => confirm(server)}>
                {t("integrations.mcp.servers.confirm")}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => edit(server)}>
              {t("integrations.mcp.servers.edit")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (
                  window.confirm(t("integrations.mcp.servers.removeConfirm", { name: server.name }))
                )
                  void run(() => window.mcpClient.remove(server.name));
              }}
            >
              {t("integrations.mcp.servers.remove")}
            </Button>
          </div>
        </SettingsPanelRow>
      ))}
      <SettingsPanelRow>
        <h4 className="text-xs font-semibold">{t("integrations.mcp.servers.add")}</h4>
        <div className="my-2 flex gap-2">
          <Button type="button" variant="outline" onClick={() => setMode("form")}>
            {t("integrations.mcp.servers.form")}
          </Button>
          <Button type="button" variant="outline" onClick={() => setMode("json")}>
            {t("integrations.mcp.servers.json")}
          </Button>
        </div>
        {mode === "json" ? (
          <textarea
            aria-label={t("integrations.mcp.servers.json")}
            className="w-full min-h-28 rounded border bg-background p-2 text-xs"
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
          />
        ) : (
          <div className="grid gap-2 text-xs">
            <input
              aria-label={t("integrations.mcp.servers.name")}
              placeholder={t("integrations.mcp.servers.name")}
              className="rounded border bg-background p-2"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <input
              aria-label={t("integrations.mcp.servers.command")}
              placeholder={t("integrations.mcp.servers.command")}
              className="rounded border bg-background p-2"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
            />
            <input
              aria-label={t("integrations.mcp.servers.args")}
              placeholder={t("integrations.mcp.servers.args")}
              className="rounded border bg-background p-2"
              value={args}
              onChange={(event) => setArgs(event.target.value)}
            />
            <input
              aria-label={t("integrations.mcp.servers.cwd")}
              placeholder={t("integrations.mcp.servers.cwd")}
              className="rounded border bg-background p-2"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
            />
            <input
              aria-label={t("integrations.mcp.servers.env")}
              placeholder={t("integrations.mcp.servers.env")}
              className="rounded border bg-background p-2"
              value={env}
              onChange={(event) => setEnv(event.target.value)}
            />
            <input
              aria-label={t("integrations.mcp.servers.headers")}
              placeholder={t("integrations.mcp.servers.headers")}
              className="rounded border bg-background p-2"
              value={headers}
              onChange={(event) => setHeaders(event.target.value)}
            />
            <input
              aria-label={t("integrations.mcp.servers.url")}
              placeholder={t("integrations.mcp.servers.url")}
              className="rounded border bg-background p-2"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>
        )}
        <textarea
          aria-label={t("integrations.mcp.servers.secrets")}
          placeholder={t("integrations.mcp.servers.secrets")}
          className="mt-2 w-full rounded border bg-background p-2 text-xs"
          value={secretFields}
          onChange={(event) => setSecretFields(event.target.value)}
        />
        <div className="mt-2">
          <Button type="button" onClick={() => void save()}>
            {t("integrations.mcp.servers.save")}
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        )}
      </SettingsPanelRow>
    </SettingsPanel>
  );
}
