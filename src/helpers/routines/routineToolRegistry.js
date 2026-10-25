const { createToolRegistry: assembleTools } = require("../../services/tools/index.ts");

// Names and schemas come from chat assembly. Main injects only local read handlers.
function createToolRegistry({
  database,
  allowedTools = [],
  finishRun,
  onUnavailable = () => {},
  mcpTools = [],
}) {
  const produced = new Set(
    database.db
      .prepare("SELECT note_id FROM routine_runs WHERE note_id IS NOT NULL")
      .all()
      .map((row) => row.note_id)
  );
  const executionOverrides = {
    search_notes: async ({ query }) => {
      try {
        const notes = database
          .searchNotes(String(query || ""), 10)
          .filter((note) => !produced.has(note.id));
        return {
          success: true,
          data: notes.map(({ id, title, created_at }) => ({ id, title, created_at })),
          displayText:
            notes
              .map(
                (note) => `[Note ${note.id}](note:${note.id}) ${note.title} (${note.created_at})`
              )
              .join("\n") || "No notes found",
        };
      } catch {
        onUnavailable("search_notes");
        return { success: false, data: null, displayText: "Notes unavailable" };
      }
    },
    get_note: async ({ id }) => {
      if (produced.has(Number(id)))
        return { success: false, data: null, displayText: "Note unavailable" };
      try {
        const note = database.getNote(Number(id));
        if (!note) return { success: false, data: null, displayText: "Note unavailable" };
        return {
          success: true,
          data: { id: note.id, title: note.title },
          displayText: `${note.title}\n${(note.enhanced_content || note.content || "").slice(0, 10000)}`,
        };
      } catch {
        onUnavailable("get_note");
        return { success: false, data: null, displayText: "Note source unavailable" };
      }
    },
    get_calendar_events: async () => {
      try {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        const events = database.getCalendarEventsInRange(start.toISOString(), end.toISOString(), [
          "google",
          "microsoft",
          "apple",
        ]);
        return {
          success: true,
          data: events.map(({ id, summary, start_time, web_link }) => ({
            id,
            summary,
            start_time,
            web_link,
          })),
          displayText:
            events
              .map((event) => `${event.summary} ${event.start_time} ${event.web_link || ""}`)
              .join("\n") || "No events today",
        };
      } catch {
        onUnavailable("get_calendar_events");
        return { success: false, data: null, displayText: "Calendar unavailable" };
      }
    },
  };
  const assembled = assembleTools({
    isSignedIn: false,
    productHelpEnabled: false,
    calendarConnected: true,
    cloudBackupEnabled: false,
    webSearchEnabled: false,
    keepNotesUnchanged: true,
    mcpTools,
    executionOverrides,
  });
  const offered = new Map();
  for (const name of allowedTools) {
    const tool = assembled.get(name);
    if (tool && (Object.hasOwn(executionOverrides, name) || mcpTools.includes(tool)))
      offered.set(name, tool);
  }
  offered.set("finish_run", {
    name: "finish_run",
    description:
      "Confirm that the routine note is complete, or declare it empty. Give a one-line notification headline.",
    parameters: {
      type: "object",
      properties: { empty: { type: "boolean" }, headline: { type: "string" } },
      required: ["empty", "headline"],
    },
    readOnly: true,
    execute: async ({ empty, headline }) => {
      finishRun({ empty: empty === true, headline: String(headline || "").slice(0, 180) });
      return { success: true, data: null, displayText: "Run completion recorded" };
    },
  });
  return {
    list: () => [...offered.values()],
    get: (name) => offered.get(name),
    assembly: assembled,
  };
}

module.exports = { createToolRegistry };
