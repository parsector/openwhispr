import type { Workspace } from "../types/electron";
import { workspaceCan } from "./capabilities.ts";

/** Enterprise admin access remains available for entitled workspaces. */
export function isEnterpriseConsoleAvailable(
  workspace: Pick<Workspace, "plan" | "status" | "role" | "capabilities">
): boolean {
  return (
    workspace.plan === "enterprise" &&
    (workspace.status === "active" || workspace.status === "trialing") &&
    workspaceCan(workspace, "manage_settings")
  );
}

/** The shared team dictionary is available to entitled Business and Enterprise workspaces. */
export function hasSharedDictionaryPlan(
  workspace: Pick<Workspace, "plan" | "status"> | null | undefined
): boolean {
  return Boolean(
    workspace &&
    (workspace.plan === "business" || workspace.plan === "enterprise") &&
    (workspace.status === "active" || workspace.status === "trialing")
  );
}
