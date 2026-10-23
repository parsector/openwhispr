import type { ToolDefinition, ToolResult } from "./ToolRegistry";

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}
export interface McpServerInfo {
  name: string;
  enabled: boolean;
  status: string;
  allowWithoutAsking: boolean;
  config: Record<string, unknown>;
  lastError: string | null;
  confirmed: boolean;
}
export interface McpClientApi {
  list(): Promise<{ revision: number; servers: McpServerInfo[] }>;
  tools(name: string): Promise<McpToolInfo[]>;
  upsert(
    name: string,
    server: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  enable(name: string, enabled: boolean): Promise<unknown>;
  confirm(name: string, details: Record<string, unknown>): Promise<unknown>;
  allow(name: string, allowed: boolean): Promise<unknown>;
  remove(name: string): Promise<unknown>;
  recent(): Promise<unknown>;
  call(
    name: string,
    tool: string,
    args: Record<string, unknown>,
    requestId: string
  ): Promise<{ content?: unknown[]; isError?: boolean }>;
  cancel(requestId: string): Promise<unknown>;
}
export const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
export const MAX_RESULT = 8000;
export function capResult(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const marker = "\n[truncated: MCP result exceeded 8000 characters]";
  return text.length <= MAX_RESULT ? text : `${text.slice(0, MAX_RESULT - marker.length)}${marker}`;
}
export function mcpCacheKey(servers: McpServerInfo[], revision: number): string {
  return `${revision}:${servers
    .filter((server) => server.enabled)
    .map((server) => `${server.name}:${server.status}`)
    .sort()
    .join("|")}`;
}
export async function loadMcpTools(
  api: McpClientApi
): Promise<{ key: string; tools: ToolDefinition[] }> {
  const state = await api.list();
  const seen = new Set<string>();
  const tools: ToolDefinition[] = [];
  for (const server of state.servers.filter(
    (item) => item.enabled && item.status === "connected"
  )) {
    for (const tool of await api.tools(server.name)) {
      const name = `${server.name}__${tool.name}`;
      if (!TOOL_NAME.test(name) || seen.has(name)) continue;
      seen.add(name);
      tools.push({
        name,
        description: tool.description || `MCP tool ${name}`,
        parameters: tool.inputSchema || { type: "object", properties: {} },
        readOnly: false,
        execute: async (args, context): Promise<ToolResult> => {
          const requestId = crypto.randomUUID();
          const onAbort = () => {
            void api.cancel(requestId);
          };
          context?.signal.addEventListener("abort", onAbort, { once: true });
          try {
            if (context?.signal.aborted)
              return { success: false, data: null, displayText: "Cancelled" };
            const result = await api.call(server.name, tool.name, args, requestId);
            const data = capResult(result.content || []);
            return { success: !result.isError, data, displayText: data };
          } catch (error) {
            return { success: false, data: null, displayText: (error as Error).message };
          } finally {
            context?.signal.removeEventListener("abort", onAbort);
          }
        },
      });
    }
  }
  return { key: mcpCacheKey(state.servers, state.revision), tools };
}
