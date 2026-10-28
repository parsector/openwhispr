import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { definitions } from "../../helpers/commitments/toolRead";

const definition = definitions.find((tool) => tool.name === "list_todos")!;

export const listTodosTool: ToolDefinition = {
  ...definition,
  readOnly: true,
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      return await window.electronAPI.todosToolList(args);
    } catch (error) {
      return { success: false, data: null, displayText: `Failed to list todos: ${(error as Error).message}` };
    }
  },
};
