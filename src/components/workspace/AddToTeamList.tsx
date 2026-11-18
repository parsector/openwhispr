import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceTeamsState } from "../../hooks/useWorkspaceTeams";
import type { Team, Workspace, WorkspaceMember } from "../../types/electron";
import { isolate } from "../../utils/bidiIsolate";
import { DropdownMenuCheckboxItem, DropdownMenuItem } from "../ui/dropdown-menu";
import { MENU_CHECK_ROW, MENU_ROWS } from "./menuTokens";

const COPY = "settingsPage.workspace.teams";

import { accessOf, addableTeams, teamCoverage } from "./teamListHelpers";

interface AddToTeamListProps {
  workspace: Workspace;
  teams: WorkspaceTeamsState;
  people: WorkspaceMember[];
  onChoose: (team: Team) => void;
}

/**
 * The content of a menu that lists the teams to add people to: a box per team showing how much of
 * the selection is on it, and the loading, failed and empty states of the list itself.
 */
export function AddToTeamList({
  workspace,
  teams,
  people,
  onChoose,
}: AddToTeamListProps): ReactElement {
  const { t } = useTranslation();

  if (teams.status === "failed") {
    return (
      <>
        <p role="status" className="px-2.5 py-2 text-sm text-muted-foreground">
          {t(`${COPY}.failedTitle`)}
        </p>
        <DropdownMenuItem
          className="text-sm"
          // Keeps the menu open, so the list can load into it.
          onSelect={(event) => {
            event.preventDefault();
            // The item unmounts while the list reloads, which would drop keyboard focus to the
            // page; the menu itself keeps it, so the arrow keys still work once the list is in.
            const menu = (event.currentTarget as HTMLElement | null)?.closest<HTMLElement>(
              '[role="menu"]'
            );
            void teams.reload().then(() => requestAnimationFrame(() => menu?.focus()));
          }}
        >
          {t(`${COPY}.retry`)}
        </DropdownMenuItem>
      </>
    );
  }
  if (teams.status !== "ready") {
    return (
      <p role="status" className="px-2.5 py-2 text-sm text-muted-foreground">
        {t(`${COPY}.loadingTitle`)}
      </p>
    );
  }

  const offered = addableTeams(teams.teams, workspace);
  if (offered.length === 0) {
    return (
      <DropdownMenuItem disabled className="text-sm text-muted-foreground">
        {/* Teams exist but are directory-managed or not the caller's to manage: "yet" would mislead. */}
        {t(`${COPY}.addPeople.${teams.teams.length === 0 ? "none" : "noneAddable"}`)}
      </DropdownMenuItem>
    );
  }

  return (
    <div
      className={`${MENU_ROWS} max-h-[min(18rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto`}
    >
      {offered.map((team) => {
        const covered = teamCoverage(people, team.id);
        const access = accessOf(covered, people.length);
        return (
          <DropdownMenuCheckboxItem
            key={team.id}
            checked={access}
            // The label starts with a bidi isolate when partly covered, which typeahead can't match.
            textValue={team.name}
            // Everyone selected is on it already, so there is nothing to add. It stays at full
            // strength, as the frame draws it: a ticked box, not a dimmed choice.
            disabled={access === true}
            onSelect={() => onChoose(team)}
            className={MENU_CHECK_ROW}
          >
            {access === "indeterminate" ? (
              <span dir="auto" className="min-w-0 flex-1 truncate">
                {t(`${COPY}.addPeople.someAdded`, {
                  team: isolate(team.name),
                  covered,
                  total: people.length,
                })}
              </span>
            ) : (
              <span dir="auto" className="min-w-0 flex-1 truncate">
                {team.name}
              </span>
            )}
          </DropdownMenuCheckboxItem>
        );
      })}
    </div>
  );
}
