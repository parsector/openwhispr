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
  maxResultChars?: number;
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
  resultSize(name: string, maxResultChars: number | null): Promise<unknown>;
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
export const RESULT_SIZE_OPTIONS = [12_000, 32_000, 64_000, 128_000, 256_000] as const;

/** One limiter per user turn; count UTF-8 bytes actually sent to the model. */
export function createMcpTurnResultLimiter(perResultBudget: number): (result: string) => string {
  const encoder = new TextEncoder();
  const aggregateBudget = perResultBudget * 3;
  let emitted = 0;
  return (result) => {
    const remaining = aggregateBudget - emitted;
    if (remaining < "[truncated]".length)
      return "[MCP tool result omitted: turn result budget exhausted]";
    const bytes = encoder.encode(result).length;
    if (bytes <= remaining) {
      emitted += bytes;
      return result;
    }
    let low = 0;
    let high = result.length;
    let fitted = "";
    while (low <= high) {
      const kept = Math.floor((low + high) / 2);
      const candidate = `${result.slice(0, kept)}\n[truncated: ${result.length - kept} of ${result.length} characters]`;
      if (encoder.encode(candidate).length <= remaining) {
        fitted = candidate;
        low = kept + 1;
      } else high = kept - 1;
    }
    // An almost empty allowance cannot hold the full marker; still signal truncation.
    const output = fitted || "[truncated]".slice(0, remaining);
    emitted += encoder.encode(output).length;
    return output;
  };
}

function trimText(text: string, budget: number): string {
  if (text.length <= budget) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    let kept = Math.max(0, budget - 35);
    let marker = `\n[truncated: ${text.length - kept} of ${text.length} characters]`;
    kept = Math.max(0, budget - marker.length);
    marker = `\n[truncated: ${text.length - kept} of ${text.length} characters]`;
    return text.slice(0, Math.max(0, budget - marker.length)) + marker;
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === "object"
      ? Object.entries(parsed)
      : [parsed];
  const isArray = Array.isArray(parsed);
  const total = entries.length;
  const output: unknown[] | Record<string, unknown> = isArray ? [] : {};
  for (let i = 0; i < total; i++) {
    if (isArray) (output as unknown[]).push(entries[i]);
    else if (Array.isArray(entries[i])) {
      const [key, item] = entries[i] as [string, unknown];
      (output as Record<string, unknown>)[key] = item;
    }
    const metadata = { truncated: true, returned: i + 1, total };
    const candidate = isArray
      ? [...(output as unknown[]), metadata]
      : { ...(output as Record<string, unknown>), ...metadata };
    if (JSON.stringify(candidate).length > budget) {
      if (isArray) (output as unknown[]).pop();
      else if (Array.isArray(entries[i])) {
        const [key, item] = entries[i] as [string, unknown];
        delete (output as Record<string, unknown>)[key];
        if (item !== null && typeof item === "object") {
          const empty = Array.isArray(item) ? [] : {};
          const nestedBudget =
            budget - JSON.stringify({ ...output, [key]: empty, ...metadata }).length + 2;
          if (nestedBudget > 0) {
            const nested = JSON.parse(trimText(JSON.stringify(item), nestedBudget));
            const withNested = { ...output, [key]: nested };
            const result = i + 1 === total ? withNested : { ...withNested, ...metadata };
            if (JSON.stringify(result).length <= budget) return JSON.stringify(result);
          }
        }
      }
      break;
    }
  }
  const returned = isArray ? (output as unknown[]).length : Object.keys(output).length;
  if (returned === total) return JSON.stringify(output);
  const metadata = { truncated: true, returned, total };
  return JSON.stringify(
    isArray ? [...(output as unknown[]), metadata] : { ...output, ...metadata }
  );
}

export function capResult(value: unknown, budget: number): string {
  if (typeof value === "string") return trimText(value, budget);
  const parts = Array.isArray(value) ? value : [value];
  const kept: unknown[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const remaining = parts.length - index - 1;
    const reserve = remaining
      ? JSON.stringify({ type: "text", text: `[truncated: ${remaining} content parts omitted]` })
          .length + 1
      : 0;
    const partBudget = budget - reserve;
    const text = part && typeof part === "object" && "text" in part ? part.text : undefined;
    if (typeof text !== "string") {
      if (JSON.stringify([...kept, part]).length > partBudget) break;
      kept.push(part);
      continue;
    }
    let low = 0;
    let high = budget;
    let fitted = "";
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = trimText(text, mid);
      if (JSON.stringify([...kept, { ...part, text: candidate }]).length <= partBudget) {
        fitted = candidate;
        low = mid + 1;
      } else high = mid - 1;
    }
    if (!fitted && text) break;
    kept.push({ ...part, text: fitted });
    if (fitted !== text) break;
  }
  if (kept.length < parts.length) {
    const marker = {
      type: "text",
      text: `[truncated: ${parts.length - kept.length} content parts omitted]`,
    };
    if (JSON.stringify([...kept, marker]).length <= budget) kept.push(marker);
  }
  return JSON.stringify(kept);
}
export function mcpCacheKey(servers: McpServerInfo[], revision: number, budget: number): string {
  return `${revision}:${budget}:${servers
    .filter((server) => server.enabled)
    .map((server) => `${server.name}:${server.status}`)
    .sort()
    .join("|")}`;
}
export async function loadMcpTools(
  api: McpClientApi,
  modelBudget: number
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
            const capped = capResult(
              result.content || [],
              Math.min(server.maxResultChars ?? modelBudget, modelBudget)
            );
            const data = context?.limitMcpResult?.(capped) ?? capped;
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
  return { key: mcpCacheKey(state.servers, state.revision, modelBudget), tools };
}
