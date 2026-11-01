import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Building2, Lock, Users } from "../icons";
import { SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";
import type { SharedScope } from "../../types/sharedDictionary";
import { workspaceListLabel, type SharedAccessState } from "./dictionaryViewModel";

export type LockedAccessState = Exclude<SharedAccessState, "available" | "unavailable">;

interface SharedDictionaryUpsellProps {
  access: LockedAccessState;
  workspaceName: string;
  // The lists the last pass read; empty when none were read for this workspace.
  scopes: SharedScope[];
}

interface LockedRow {
  key: string;
  icon: ReactNode;
  title: string;
  subtitle: string;
}

const workspaceFirst = (scopes: SharedScope[]): SharedScope[] => [
  ...scopes.filter((scope) => scope.space_id === null),
  ...scopes.filter((scope) => scope.space_id !== null),
];

const WORKSPACE_ICON = <Building2 className="h-4 w-4 text-primary/80" aria-hidden="true" />;
const SPACE_ICON = <Users className="h-4 w-4 text-primary/80" aria-hidden="true" />;

// Sign-in and lost access have specific guidance; other states show entitlement information.
const ACCESS_BLOCKED = new Set<LockedAccessState>(["ssoRequired", "noAccess"]);
const LOCK_ICON = <Lock size={15} className="shrink-0 text-primary" aria-hidden="true" />;

/** Access information for a Shared list the member cannot use. */
export function SharedDictionaryUpsell({
  access,
  workspaceName,
  scopes,
}: SharedDictionaryUpsellProps): ReactElement {
  const { t } = useTranslation();
  const message =
    access === "ssoRequired" || access === "noAccess"
      ? t(`dictionary.shared.locked.${access}`, { workspace: workspaceName })
      : access === "paused"
        ? `${t("dictionary.shared.locked.lockLabel")} · ${t("dictionary.shared.locked.wordCount", {
            count: scopes.reduce((total, scope) => total + scope.word_count, 0),
          })}`
        : t("dictionary.shared.locked.lockLabel");
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3.5 py-2">
      {LOCK_ICON}
      <p className="text-xs text-foreground/85 leading-relaxed">{message}</p>
    </div>
  );
}

/** Access notice above lists that are paused or unavailable. */
export function SharedDictionaryLocked(props: SharedDictionaryUpsellProps): ReactElement {
  const { access, workspaceName, scopes } = props;
  const { t } = useTranslation();

  // Without real lists to show (no workspace, or none read yet) the rows say what Business adds.
  const describedRows = (workspaceTitle: string): LockedRow[] => [
    {
      key: "workspace",
      icon: WORKSPACE_ICON,
      title: workspaceTitle,
      subtitle: t("dictionary.shared.locked.workspaceDescription"),
    },
    {
      key: "space",
      icon: SPACE_ICON,
      title: t("dictionary.shared.locked.spaceTitle"),
      subtitle: t("dictionary.shared.locked.spaceDescription"),
    },
  ];

  if (ACCESS_BLOCKED.has(access)) return <SharedDictionaryUpsell {...props} />;

  const rows: LockedRow[] =
    access === "noWorkspace"
      ? describedRows(t("dictionary.shared.locked.workspaceTitle"))
      : scopes.length === 0
        ? describedRows(workspaceListLabel(workspaceName, t))
        : workspaceFirst(scopes).map((scope) => ({
            key: scope.space_id ?? "workspace",
            icon: scope.space_id === null ? WORKSPACE_ICON : SPACE_ICON,
            title: scope.space_id === null ? workspaceListLabel(workspaceName, t) : scope.name,
            // Paused lists show what was kept; the others who the list would reach.
            subtitle:
              access === "paused"
                ? t("dictionary.shared.locked.wordCount", { count: scope.word_count })
                : t("dictionary.shared.memberCount", { count: scope.member_count }),
          }));

  return (
    <div className="space-y-3">
      <SharedDictionaryUpsell {...props} />
      <SettingsPanel>
        {rows.map((row) => (
          <SettingsPanelRow key={row.key}>
            <div className="flex items-center gap-3 opacity-60">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/5 dark:bg-primary/10">
                {row.icon}
              </div>
              <div className="min-w-0 flex-1">
                <p dir="auto" className="truncate text-xs font-semibold text-foreground">
                  {row.title}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/70">
                  {row.subtitle}
                </p>
              </div>
              <Lock
                size={14}
                role="img"
                aria-label={t("dictionary.shared.locked.lockLabel")}
                className="shrink-0 text-muted-foreground"
              />
            </div>
          </SettingsPanelRow>
        ))}
      </SettingsPanel>
    </div>
  );
}
