import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import todoDefinitions from "../../helpers/commitments/todoToolDefinitions.json";

const definition = todoDefinitions.update;

export const updateTodoTool: ToolDefinition = {
  name: definition.name,
  description: definition.description,
  parameters: definition.parameters,
  readOnly: false,
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      return await window.electronAPI.todosToolUpdate(args);
    } catch (error) {
      return { success: false, data: null, displayText: (error as Error).message };
    }
  },
};
