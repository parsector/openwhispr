import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { definitions } from "../../helpers/commitments/toolWrite";

const definition = definitions.find((tool) => tool.name === "update_todo")!;

export const updateTodoTool: ToolDefinition = {
  name: definition.name,
  description: definition.description,
  parameters: definition.parameters,
  readOnly: false,
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try { return await window.electronAPI.todosToolUpdate(args); }
    catch (error) { return { success: false, data: null, displayText: (error as Error).message }; }
  },
};
