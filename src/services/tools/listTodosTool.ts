import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import todoDefinitions from "../../helpers/commitments/todoToolDefinitions.json";

const definition = todoDefinitions.list;

export const listTodosTool: ToolDefinition = {
  ...definition,
  readOnly: true,
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      return await window.electronAPI.todosToolList(args);
    } catch (error) {
      return {
        success: false,
        data: null,
        displayText: `Failed to list todos: ${(error as Error).message}`,
      };
    }
  },
};
