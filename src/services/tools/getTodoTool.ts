import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import todoDefinitions from "../../helpers/commitments/todoToolDefinitions.json";

const definition = todoDefinitions.get;

export const getTodoTool: ToolDefinition = {
  ...definition,
  readOnly: true,
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      return await window.electronAPI.todosToolGet(args);
    } catch (error) {
      return {
        success: false,
        data: null,
        displayText: `Failed to get todo: ${(error as Error).message}`,
      };
    }
  },
};
