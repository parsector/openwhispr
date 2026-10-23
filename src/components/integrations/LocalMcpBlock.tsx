import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { CopyableCommand } from "../ui/CopyableCommand";
import { SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";

type State = Awaited<ReturnType<typeof window.electronAPI.localMcpState>>;

export function LocalMcpBlock() {
  const { t } = useTranslation();
  const [state, setState] = useState<State | null>(null);
  const [label, setLabel] = useState("");
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => window.electronAPI.localMcpState().then(setState);
  useEffect(() => {
    void refresh().catch((cause) => setError(String(cause)));
  }, []);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-xs font-semibold text-foreground">
          {t("integrations.mcp.local.title")}
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          {t("integrations.mcp.local.description")}
        </p>
      </div>
      <SettingsPanel>
        <SettingsPanelRow>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium">{t("integrations.mcp.local.enable")}</span>
            <input
              type="checkbox"
              checked={state?.enabled ?? false}
              disabled={!state || busy}
              aria-label={t("integrations.mcp.local.enable")}
              onChange={(event) =>
                void run(() => window.electronAPI.localMcpEnable(event.target.checked))
              }
              className="accent-primary"
            />
          </div>
          {state?.url && (
            <CopyableCommand
              className="mt-3"
              command={state.url}
              copyLabel={t("integrations.mcp.local.copyUrl")}
            />
          )}
        </SettingsPanelRow>
        <SettingsPanelRow className="space-y-2">
          <h4 className="text-xs font-semibold">{t("integrations.mcp.local.tokens")}</h4>
          <div className="flex flex-wrap gap-2">
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={100}
              aria-label={t("integrations.mcp.local.tokenLabel")}
              placeholder={t("integrations.mcp.local.tokenLabel")}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !label.trim()}
              onClick={() =>
                void run(async () => {
                  const token = await window.electronAPI.localMcpCreateToken(label);
                  setPlaintext(token.plaintext);
                  setLabel("");
                })
              }
            >
              {t("integrations.mcp.local.create")}
            </Button>
          </div>
          {plaintext && (
            <div className="space-y-1" role="status">
              <p className="text-xs text-muted-foreground">
                {t("integrations.mcp.local.shownOnce")}
              </p>
              <CopyableCommand
                command={plaintext}
                copyLabel={t("integrations.mcp.local.copyToken")}
              />
              <Button size="sm" variant="ghost" onClick={() => setPlaintext(null)}>
                {t("integrations.mcp.local.dismiss")}
              </Button>
            </div>
          )}
          {state?.tokens.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("integrations.mcp.local.noTokens")}</p>
          )}
          {state?.tokens.map((token) => (
            <div key={token.id} className="flex items-center justify-between gap-2 text-xs">
              <div className="min-w-0">
                <span className="font-medium break-all">{token.label}</span>
                <span className="ms-2 text-muted-foreground">
                  {t("integrations.mcp.local.created")}:{" "}
                  {new Date(token.createdAt).toLocaleString()}
                </span>
                {token.lastUsedAt && (
                  <span className="ms-2 text-muted-foreground">
                    {t("integrations.mcp.local.lastUsed")}:{" "}
                    {new Date(token.lastUsedAt).toLocaleString()}
                  </span>
                )}
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void run(() => window.electronAPI.localMcpRevokeToken(token.id))}
              >
                {t("integrations.mcp.local.revoke")}
              </Button>
            </div>
          ))}
        </SettingsPanelRow>
        <SettingsPanelRow className="space-y-2">
          <h4 className="text-xs font-semibold">{t("integrations.mcp.local.activity")}</h4>
          {state?.activity.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {t("integrations.mcp.local.noActivity")}
            </p>
          )}
          {state?.activity
            .slice()
            .reverse()
            .map((entry, index) => (
              <p key={`${entry.timestamp}-${index}`} className="text-xs text-muted-foreground">
                <span className="text-foreground">{entry.clientName}</span> · {entry.tool} ·{" "}
                {new Date(entry.timestamp).toLocaleString()}
              </p>
            ))}
        </SettingsPanelRow>
      </SettingsPanel>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
