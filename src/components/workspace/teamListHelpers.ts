import { teamCan } from "../../lib/capabilities";
import type { Team, Workspace, WorkspaceMember } from "../../types/electron";

/** Pure: how many of these people the roster already has on this team. */
export function teamCoverage(people: WorkspaceMember[], teamId: string): number {
  return people.filter((person) => person.teams?.some((team) => team.id === teamId)).length;
}

/**
 * The teams people can be added to here, in name order: the ones the caller manages the roster of,
 * less those a directory sync owns, whose membership the server refuses to change.
 */
export function addableTeams(teams: Team[], workspace: Workspace): Team[] {
  return teams
    .filter((team) => !team.directory_synced && teamCan(team, workspace, "manage_members"))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/**
 * The settings dialog a menu opens in. A submenu keeps inside it, so one that has no room on the
 * right opens on the left, as the frames draw.
 */
export function dialogBoundaryOf(element: HTMLElement | null): Element | null {
  return element?.closest('[role="dialog"]') ?? null;
}

// One box state for the row: nobody, some (a dash) or everyone selected is on the team or teamspace.
export function accessOf(covered: number, total: number): boolean | "indeterminate" {
  if (total > 0 && covered >= total) return true;
  return covered > 0 ? "indeterminate" : false;
}

