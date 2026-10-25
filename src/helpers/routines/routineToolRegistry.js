// Main-process projection of the read-only note and calendar tool allowlist.
// These handlers use DatabaseManager directly; renderer tools require `window`.
function createToolRegistry({ database, allowedTools = [], finishRun, onUnavailable = () => {} }) {
  const produced = new Set(
    database.db
      .prepare("SELECT note_id FROM routine_runs WHERE note_id IS NOT NULL")
      .all()
      .map((row) => row.note_id)
  );
  const definitions = {
    search_notes: {
      name: "search_notes",
      description: "Search personal notes by keyword. Routine-produced notes are excluded.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      readOnly: true,
      execute: async ({ query }) => {
        let notes;
        try {
          notes = database
            .searchNotes(String(query || ""), 10)
            .filter((note) => !produced.has(note.id));
        } catch {
          onUnavailable("search_notes");
          return { success: false, data: null, displayText: "Notes unavailable" };
        }
        return {
          success: true,
          data: notes.map(({ id, title, created_at }) => ({ id, title, created_at })),
          displayText:
            notes
              .map((note) => `[note:${note.id}] ${note.title} (${note.created_at})`)
              .join("\n") || "No notes found",
        };
      },
    },
    get_note: {
      name: "get_note",
      description: "Read one personal note by numeric ID. Routine-produced notes are excluded.",
      parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
      readOnly: true,
      execute: async ({ id }) => {
        if (produced.has(Number(id)))
          return { success: false, data: null, displayText: "Note unavailable" };
        let note;
        try {
          note = database.getNote(Number(id));
        } catch {
          onUnavailable("get_note");
          return { success: false, data: null, displayText: "Note source unavailable" };
        }
        if (!note) return { success: false, data: null, displayText: "Note unavailable" };
        const text = `${note.title}\n${(note.enhanced_content || note.content || "").slice(0, 10000)}`;
        return { success: true, data: { id: note.id, title: note.title }, displayText: text };
      },
    },
    get_calendar_events: {
      name: "get_calendar_events",
      description: "Read today's calendar events.",
      parameters: { type: "object", properties: {} },
      readOnly: true,
      execute: async () => {
        let events;
        try {
          const start = new Date();
          start.setHours(0, 0, 0, 0);
          const end = new Date(start);
          end.setDate(end.getDate() + 1);
          events = database.getCalendarEventsInRange(start.toISOString(), end.toISOString(), [
            "google",
            "microsoft",
            "apple",
          ]);
        } catch {
          onUnavailable("get_calendar_events");
          return { success: false, data: null, displayText: "Calendar unavailable" };
        }
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
      },
    },
    finish_run: {
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
    },
  };
  const names = new Set(
    allowedTools.filter((name) =>
      ["search_notes", "get_note", "get_calendar_events"].includes(name)
    )
  );
  names.add("finish_run");
  return {
    list: () => [...names].map((name) => definitions[name]),
    get: (name) => (names.has(name) ? definitions[name] : undefined),
  };
}

module.exports = { createToolRegistry };
