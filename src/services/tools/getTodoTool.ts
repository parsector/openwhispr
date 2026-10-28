import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { definitions } from "../../helpers/commitments/toolRead";

const definition = definitions.find((tool) => tool.name === "get_todo")!;

export const getTodoTool: ToolDefinition = {
  ...definition,
  readOnly: true,
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      return await window.electronAPI.todosToolGet(args);
    } catch (error) {
      return { success: false, data: null, displayText: `Failed to get todo: ${(error as Error).message}` };
    }
  },
};
