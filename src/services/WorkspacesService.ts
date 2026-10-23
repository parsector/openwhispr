import { cloudGet, cloudPost, cloudPatch, cloudDelete, type DataWrap } from "./cloudApi.js";
import type {
  JoinableWorkspace,
  Workspace,
  WorkspaceJoinRequest,
  WorkspaceMember,
} from "../types/electron";

async function list(): Promise<Workspace[]> {
  const res = await cloudGet<DataWrap<Workspace[]>>("/api/workspaces");
  return res.data;
}

async function create(name: string): Promise<Workspace> {
  const res = await cloudPost<DataWrap<Workspace>>("/api/workspaces", { name });
  return res.data;
}

async function update(workspaceId: string, patch: { name?: string }): Promise<Workspace> {
  const res = await cloudPatch<DataWrap<Workspace>>(`/api/workspaces/${workspaceId}`, patch);
  return res.data;
}

async function remove(workspaceId: string): Promise<void> {
  await cloudDelete(`/api/workspaces/${workspaceId}`);
}

async function listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const res = await cloudGet<DataWrap<WorkspaceMember[]>>(`/api/workspaces/${workspaceId}/members`);
  return res.data;
}

async function updateMemberRole(
  workspaceId: string,
  userId: string,
  role: "owner" | "admin" | "member"
): Promise<void> {
  await cloudPatch(`/api/workspaces/${workspaceId}/members/${userId}`, { role });
}

async function removeMember(workspaceId: string, userId: string): Promise<void> {
  await cloudDelete(`/api/workspaces/${workspaceId}/members/${userId}`);
}

/** Invitations the caller can accept and company-domain workspaces they can ask to join. */
async function listJoinable(): Promise<JoinableWorkspace[]> {
  const res = await cloudGet<DataWrap<JoinableWorkspace[]>>("/api/me/joinable");
  return res.data;
}

async function join(workspaceId: string): Promise<{ workspace_id: string; role: string }> {
  const res = await cloudPost<DataWrap<{ workspace_id: string; role: string }>>(
    "/api/me/joinable",
    { workspace_id: workspaceId }
  );
  return res.data;
}

/** Ask a workspace's admins for access. Grants nothing until one approves. */
async function requestJoin(workspaceId: string): Promise<void> {
  await cloudPost("/api/me/joinable/request", { workspace_id: workspaceId });
}

async function listJoinRequests(workspaceId: string): Promise<WorkspaceJoinRequest[]> {
  const res = await cloudGet<DataWrap<WorkspaceJoinRequest[]>>(
    `/api/workspaces/${workspaceId}/join-requests`
  );
  return res.data;
}

async function decideJoinRequest(
  workspaceId: string,
  requestId: string,
  decision: "approve" | "deny"
): Promise<void> {
  await cloudPatch(`/api/workspaces/${workspaceId}/join-requests/${requestId}`, { decision });
}

export const WorkspacesService = {
  listJoinable,
  join,
  requestJoin,
  listJoinRequests,
  decideJoinRequest,
  list,
  create,
  update,
  remove,
  listMembers,
  updateMemberRole,
  removeMember,
};
