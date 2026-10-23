const { searchNotes } = require("./searchNotes");

const definitions = [
  { name: "search_notes", description: "Search local notes in every space.", inputSchema: {
    type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 }, space: { type: "string" } }, required: ["query"], additionalProperties: false,
  } },
  { name: "get_note", description: "Read a local note by numeric ID.", inputSchema: {
    type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false,
  } },
  { name: "list_folders", description: "List local note folders and their spaces.", inputSchema: {
    type: "object", properties: {}, additionalProperties: false,
  } },
];

function capResult(value) {
  const full = JSON.stringify(value);
  if (full.length <= 8000) return full;
  const marker = `\n[TRUNCATED; untruncated length: ${full.length} characters]`;
  return full.slice(0, 8000 - marker.length) + marker;
}

function createTools(database, getSemanticSearch) {
  async function call(name, args = {}) {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid arguments");
    const keys = Object.keys(args);
    const definition = definitions.find((tool) => tool.name === name);
    if (!definition) throw new Error("Unknown tool");
    if (keys.some((key) => !(key in definition.inputSchema.properties))) throw new Error("Unknown argument");
    const spaces = database.getSpaces(true);
    const spaceNames = new Map(spaces.map((space) => [space.id, space.name]));
    let result;
    if (name === "search_notes") {
      if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 500 ||
          (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20))) {
        throw new Error("Invalid search query or limit");
      }
      let space;
      if (args.space !== undefined) {
        if (typeof args.space !== "string") throw new Error("Invalid space");
        space = spaces.find((item) => item.name.toLowerCase() === args.space.toLowerCase());
        if (!space) throw new Error("Space not found");
      }
      const notes = await searchNotes({ database, getSemanticSearch, query: args.query, limit: args.limit ?? 5, spaceId: space?.id, allSpaces: true });
      const data = notes.map((note) => ({
        id: note.id, title: note.title, date: note.created_at, type: note.note_type,
        space: spaceNames.get(note.space_id) ?? null,
        content: (note.enhanced_content || note.content || "").slice(0, 500),
      }));
      result = { success: true, data, displayText: data.length ? `Found ${data.length} notes for "${args.query}" (semantic search)` : `No notes found for "${args.query}"` };
    } else if (name === "get_note") {
      if (!Number.isSafeInteger(args.id) || args.id < 1) throw new Error("Invalid note ID");
      const note = database.getNote(args.id, true);
      result = note ? { success: true, data: {
        id: note.id, title: note.title, content: note.content, summary: note.enhanced_content ?? "",
        transcript: (note.transcript ?? "").slice(0, 500), type: note.note_type,
        folder_id: note.folder_id, created_at: note.created_at, updated_at: note.updated_at,
      }, displayText: `Retrieved note: "${note.title}"` } :
        { success: false, data: null, displayText: `Note with ID ${args.id} not found` };
    } else {
      const data = database.getFolders(null, true).map((folder) => ({ id: folder.id, name: folder.name, space: spaceNames.get(folder.space_id) ?? null }));
      result = { success: true, data, displayText: data.length ? `Folders: ${data.map((folder) => folder.name).join(", ")}` : "No folders" };
    }
    return { content: [{ type: "text", text: capResult(result) }], isError: !result.success };
  }
  return { definitions, call };
}

module.exports = { createTools, capResult };
