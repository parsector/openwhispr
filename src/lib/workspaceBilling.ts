import type { Workspace } from "../types/electron";
import { canManageWorkspace } from "./spacePermissions.ts";

/** Enterprise admin access remains available for entitled workspaces. */
export function isEnterpriseConsoleAvailable(
  workspace: Pick<Workspace, "plan" | "status" | "role">
): boolean {
  return (
    workspace.plan === "enterprise" &&
    (workspace.status === "active" || workspace.status === "trialing") &&
    canManageWorkspace(workspace.role)
  );
}
