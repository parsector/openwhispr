import { useEffect, useReducer, useRef, useState, type ReactElement, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspaceTeams, type WorkspaceTeamsState } from "../../hooks/useWorkspaceTeams";
import { teamCreationFor } from "../../lib/capabilities";
import { confirmActionReducer } from "../../lib/confirmActionFlow";
import { formatList } from "../../lib/formatList";
import { classifyTeamError } from "../../lib/workspaceErrors";
import { serverRefusalMessage } from "../../services/cloudApi";
import { addPeopleToTeam } from "../../services/spaceActions";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { Team, Workspace, WorkspaceMember } from "../../types/electron";
import { isolate } from "../../utils/bidiIsolate";
import { ChevronDown, Plus, UserPlus } from "../icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useToast } from "../ui/useToast";
import { MENU_ICON, MENU_PANEL, MENU_ROW, MENU_ROWS, MENU_SUBMENU_TRIGGER } from "./menuTokens";
import { dialogBoundaryOf, teamCoverage } from "./teamListHelpers";
import { AddToTeamList } from "./AddToTeamList";
import type { AddToTeamspace } from "./AddToTeamspaceMenu";
import { WorkspaceActionDialog } from "./WorkspaceActionDialog";
import { RAISED_PILL, SPLIT_PILL, SPLIT_PILL_CHEVRON, SPLIT_PILL_LABEL } from "./dialogButtons";
import { cn } from "../lib/utils";


import type { PeopleAddMenuProps } from "./useAddPeopleToTeam";
export function PeopleAddMenu({
  workspace,
  people,
  onAdded,
  teamAdd,
  teamspace,
  openerRef,
  onCreateTeam,
}: PeopleAddMenuProps): ReactElement {
  const { t } = useTranslation();
  const labelRef = useRef<HTMLButtonElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const [boundary, setBoundary] = useState<Element | null>(null);

  const choose = (team: Team): void =>
    teamAdd.add(team, people, {
      onAdded,
      returnFocus: () => openerRef.current?.focus(),
    });

  return (
    <div className={cn(SPLIT_PILL, RAISED_PILL)}>
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) return;
          openerRef.current = labelRef.current;
          teamAdd.menuOpened();
          teamAdd.open();
        }}
      >
        <DropdownMenuTrigger asChild>
          <button ref={labelRef} type="button" className={SPLIT_PILL_LABEL}>
            <Plus className="size-3.5" aria-hidden="true" />
            {t("settingsPage.workspace.people.selection.addToTeam")}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="w-64 max-w-[calc(100vw-32px)]">
          <AddToTeamList
            workspace={workspace}
            teams={teamAdd.teams}
            people={people}
            onChoose={choose}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) return;
          openerRef.current = chevronRef.current;
          setBoundary(dialogBoundaryOf(chevronRef.current));
          teamAdd.menuOpened();
          teamspace.menuOpened();
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            ref={chevronRef}
            type="button"
            aria-label={t("settingsPage.workspace.people.addMenu.label")}
            className={SPLIT_PILL_CHEVRON}
          >
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className={`${MENU_PANEL} ${MENU_ROWS}`}>
          <DropdownMenuSub onOpenChange={(open) => open && teamAdd.open()}>
            <DropdownMenuSubTrigger className={MENU_SUBMENU_TRIGGER}>
              <UserPlus className={MENU_ICON} aria-hidden="true" />
              {t("settingsPage.workspace.people.selection.addToTeam")}
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent
                sideOffset={6}
                collisionBoundary={boundary ?? undefined}
                className={MENU_PANEL}
              >
                <AddToTeamList
                  workspace={workspace}
                  teams={teamAdd.teams}
                  people={people}
                  onChoose={choose}
                />
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
          {teamspace.submenu}
          {teamCreationFor(workspace) !== "unavailable" ? (
            <>
              <DropdownMenuSeparator className="mx-0 my-0" />
              <DropdownMenuItem className={MENU_ROW} onSelect={onCreateTeam}>
                <UserPlus className={MENU_ICON} aria-hidden="true" />
                {t("settingsPage.workspace.people.selection.createTeam")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
