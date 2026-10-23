import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../ui/badge";
import { CopyableCommand } from "../ui/CopyableCommand";
import { SectionLabel, SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";
import { IntegrationsPane } from "./IntegrationsPane";

const CLI_DOCS_URL = "https://docs.openwhispr.com/cli/install";
const INSTALL_CMD = "npm install -g @openwhispr/cli";
const LOCAL_EXAMPLE = "openwhispr --local notes list";
const CLOUD_LOGIN_CMD = "openwhispr auth login";

interface CliPaneProps {
  title: string;
  isPaid: boolean;
}

export function CliPane({ title, isPaid }: CliPaneProps): ReactElement {
  const { t } = useTranslation();

  return (
    <IntegrationsPane
      title={title}
      description={t("integrations.cli.description")}
      docsUrl={CLI_DOCS_URL}
    >
      <div>
        <SectionLabel>{t("integrations.cli.installLabel")}</SectionLabel>
        <CopyableCommand command={INSTALL_CMD} />
      </div>

      <div className="grid gap-3 @min-[56rem]:grid-cols-2">
        <SettingsPanel>
          <SettingsPanelRow className="space-y-2.5">
            <div>
              <div className="flex h-[18px] items-center gap-1.5">
                <h3 className="text-xs font-semibold text-foreground">
                  {t("integrations.cli.local.label")}
                </h3>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
                  {t("integrations.cli.local.freeBadge")}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">
                {t("integrations.cli.local.description")}
              </p>
            </div>
            <CopyableCommand command={LOCAL_EXAMPLE} />
          </SettingsPanelRow>
        </SettingsPanel>

        <SettingsPanel>
          <SettingsPanelRow className="space-y-2.5">
            <div>
              <div className="flex h-[18px] items-center gap-1.5">
                <h3 className="text-xs font-semibold text-foreground">
                  {t("integrations.cli.cloud.label")}
                </h3>
              </div>
              <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">
                {isPaid
                  ? t("integrations.cli.cloud.description")
                  : t("common.unavailableInBuild")}
              </p>
            </div>
            {isPaid ? (
              <CopyableCommand command={CLOUD_LOGIN_CMD} />
            ) : (
              <p className="text-xs text-muted-foreground">{t("common.unavailableInBuild")}</p>
            )}
          </SettingsPanelRow>
        </SettingsPanel>
      </div>
    </IntegrationsPane>
  );
}
