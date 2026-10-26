const { localDate } = require("./routineSchedulePolicy");
const { routineEndpointSupportsTools } = require("../../utils/modelCapability.ts");
const { createToolRegistry } = require("./routineToolRegistry");
const { loadRoutineMcpTools } = require("../../services/tools/mcpTools.ts");

const DAY = 86400000;
function linkNoteReferences(text) {
  return String(text || "")
    .replace(/\[note:(\d+)\]/g, (_, id) => `[Note ${id}](note:${id})`)
    .replace(/(?<!\]\()\bnote:(\d+)\b/g, (_, id) => `[Note ${id}](note:${id})`);
}
function actionItemContext(database, now) {
  const scope = database._accountScopeCondition("notes");
  const rows = database.db
    .prepare(
      `SELECT id,title,created_at,participants,enhanced_content,content
    FROM notes WHERE deleted_at IS NULL AND datetime(created_at) >= datetime(?) AND ${scope.sql}
    AND id NOT IN (SELECT note_id FROM routine_runs WHERE note_id IS NOT NULL)
    ORDER BY created_at DESC LIMIT 200`
    )
    .all(new Date(now - 7 * DAY).toISOString(), ...scope.params);
  let scanned = 0;
  let matched = 0;
  let chars = 0;
  const sections = [];
  for (const note of rows) {
    if (scanned >= 20 || chars >= 60000) break;
    scanned++;
    const lines = (note.enhanced_content || note.content || "")
      .split("\n")
      .filter((line) => /^\s*- \[[ xX]\]/.test(line));
    if (!lines.length) continue;
    matched++;
    const section = `[Note ${note.id}](note:${note.id}) ${note.title} (${note.created_at})\nAttendees: ${note.participants || "none"}\n${lines.join("\n")}`;
    sections.push(section.slice(0, Math.max(0, 60000 - chars)));
    chars += section.length;
  }
  return {
    text: `Action items: ${scanned} notes scanned, ${matched} with checkboxes\n${sections.join("\n\n")}`,
    scanned,
    matched,
  };
}

function selectedNoteContext(database, config, now) {
  if (!config) return null;
  const scope = database._accountScopeCondition("notes");
  const rows = database.db.prepare(
    `SELECT notes.id,notes.title,notes.created_at,notes.participants,
      notes.enhanced_content,notes.content,notes.folder_id,folders.routine_id
     FROM notes LEFT JOIN folders ON folders.id=notes.folder_id
     WHERE notes.deleted_at IS NULL AND datetime(notes.created_at)>=datetime(?)
       AND ${scope.sql}
       AND notes.id NOT IN (SELECT note_id FROM routine_runs WHERE note_id IS NOT NULL)
     ORDER BY notes.created_at DESC, notes.id DESC LIMIT 200`
  ).all(new Date(now - config.lookback_days * DAY).toISOString(), ...scope.params);
  const folders = config.folder_ids === null ? null : new Set(config.folder_ids);
  const people = config.people === null ? null : new Set(config.people.map((value) => value.toLowerCase()));
  let count = 0;
  let chars = 0;
  const sections = [];
  for (const note of rows) {
    if (count >= 20 || chars >= 60000) break;
    if (note.routine_id || (folders && !folders.has(note.folder_id))) continue;
    let participants = [];
    try {
      const parsed = JSON.parse(note.participants || "[]");
      if (Array.isArray(parsed)) participants = parsed;
    } catch { /* malformed metadata */ }
    if (people && !participants.some((person) =>
      typeof person.email === "string" && people.has(person.email.trim().toLowerCase()))) continue;
    const names = participants.map((person) => person.displayName || person.email).filter(Boolean);
    const section = `[Note ${note.id}](note:${note.id}) ${note.title} (${note.created_at})\nPeople: ${names.join(", ") || "none"}\n${note.enhanced_content || note.content || ""}`;
    const separator = sections.length ? 2 : 0;
    const remaining = 60000 - chars - separator;
    if (remaining <= 0) break;
    sections.push(section.slice(0, remaining));
    chars += separator + Math.min(section.length, remaining);
    count++;
  }
  return { text: sections.join("\n\n") || "No selected notes", count };
}

function calendarContext(database, now) {
  try {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const events = database.getCalendarEventsInRange(start.toISOString(), end.toISOString(), [
      "google",
      "microsoft",
      "apple",
    ]);
    const produced = new Set(
      database.db
        .prepare("SELECT note_id FROM routine_runs WHERE note_id IS NOT NULL")
        .all()
        .map((row) => row.note_id)
    );
    const lines = events.map((event) => {
      let related = [];
      try {
        related = database
          .searchNotes(event.summary || "", 3)
          .filter((note) => !produced.has(note.id));
      } catch {
        related = [];
      }
      return (
        `${event.summary} — ${event.start_time} ${event.web_link || event.hangout_link || ""}\n` +
        related
          .map((note) => `Related: [Note ${note.id}](note:${note.id}) ${note.title}`)
          .join("\n")
      );
    });
    return { text: lines.join("\n") || "No meetings today", status: "ok" };
  } catch (error) {
    return { text: "Calendar unavailable", status: "unavailable", error: error.message };
  }
}

function meetingContext(database, noteId) {
  if (database.db.prepare("SELECT 1 FROM routine_runs WHERE note_id=? LIMIT 1").get(noteId))
    throw new Error("Routine notes cannot be meeting sources");
  const note = database.getNote(noteId);
  if (!note || note.deleted_at) throw new Error("Source meeting note unavailable");
  const event = note.calendar_event_id ? database.getCalendarEventById(note.calendar_event_id) : null;
  return `Meeting note: [${note.title}](note:${note.id})\nNote content:\n${note.content || "none"}\nTranscript (including speaker labels when available):\n${note.transcript || "none"}\nAttendees: ${note.participants || "none"}\nCalendar event: ${event ? `${event.summary} — ${event.start_time}` : "none"}\nsummary: ${note.enhanced_content || "not yet generated"}`;
}

function eventContext(database, eventId) {
  const event = database.getCalendarEventById(eventId);
  if (!event || event.status === "cancelled") throw new Error("Calendar event unavailable");
  let people = [];
  try {
    const attendees = JSON.parse(event.attendees || "[]");
    if (Array.isArray(attendees)) people = attendees
      .filter((person) => !person.self && typeof person.email === "string")
      .map((person) => person.email.trim().toLowerCase());
  } catch { /* malformed attendee metadata */ }
  let history = "No prior notes with these attendees";
  let status = "ok";
  if (people.length) {
    try {
      history = selectedNoteContext(database, { folder_ids: null, people, lookback_days: 90 }, Date.now()).text;
    } catch {
      history = "Prior notes unavailable";
      status = "unavailable";
    }
  }
  return { text: `Upcoming meeting: ${event.summary} — ${event.start_time}\nAttendees: ${event.attendees || "none"}\nMeeting link: ${event.web_link || event.hangout_link || "none"}\nHistory with these attendees:\n${history}`, status };
}

function noteTitle(database, routine, now) {
  const date = localDate(new Date(now));
  const base = `${routine.name} — ${date}`;
  const scope = database._accountScopeCondition("notes");
  const exists = database.db
    .prepare(`SELECT 1 FROM notes WHERE title=? AND ${scope.sql} LIMIT 1`)
    .get(base, ...scope.params);
  return exists
    ? `${base} ${new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`
    : base;
}

class RoutineRunner {
  constructor({ database, infer, notify = () => {}, mcpApi = null, modelUsable = () => true }) {
    this.database = database;
    this.infer = infer;
    this.notify = notify;
    this.mcpApi = mcpApi;
    this.modelUsable = modelUsable;
  }

  async run(job) {
    const { completion } = await import("./routineCompletion.js");
    const { database } = this;
    const routine = database.getRoutine(job.routineId);
    if (!routine) throw new Error("Routine not found");
    const now = Date.now();
    database.updateRoutineRun(job.id, {
      status: "running",
      started_at: new Date(now).toISOString(),
    });
    database.db
      .prepare("UPDATE routines SET last_run_at=? WHERE id=?")
      .run(new Date(now).toISOString(), routine.id);
    try {
      const readNotes = routine.allowed_tools.some((name) => name === "search_notes" || name === "get_note");
      const readCalendar = routine.allowed_tools.includes("get_calendar_events");
      let actions = null;
      if (readNotes) {
        try {
          actions = actionItemContext(database, now);
        } catch {
          actions = {
            text: "Action items unavailable",
            scanned: 0,
            matched: 0,
            status: "unavailable",
          };
        }
      }
      const calendar = readCalendar ? calendarContext(database, now) : null;
      let selectedNotes;
      if (readNotes) {
        try { selectedNotes = selectedNoteContext(database, routine.source_config, now); }
        catch { selectedNotes = { text: "Selected notes unavailable", count: 0, status: "unavailable" }; }
      }
      const sourceStatus = {
        ...(actions ? { action_items: actions.status === "unavailable"
          ? "unavailable" : { scanned: actions.scanned, matched: actions.matched } } : {}),
        ...(calendar ? { calendar: calendar.status } : {}),
        ...(selectedNotes ? { selected_notes: selectedNotes.status || { matched: selectedNotes.count } } : {}),
        ...(job.trigger === "meeting_ended" ? { diarization: job.diarization || "pending" } : {}),
      };
      let model = job.model;
      let modelWarning = "";
      if (routine.model_override) {
        if (await this.modelUsable(routine.model_override)) model = routine.model_override;
        else modelWarning = `model override unavailable, used ${model?.model || "default"}`;
      }
      if (modelWarning) sourceStatus.model_override = modelWarning;
      const toolsAvailable = routineEndpointSupportsTools(model);
      if (!toolsAvailable) {
        for (const name of routine.allowed_tools)
          sourceStatus[name] = "unavailable: needs a tool-capable model";
      }
      let finishRun = null;
      let mcpTools = [];
      if (toolsAvailable && this.mcpApi) {
        try {
          mcpTools = await loadRoutineMcpTools(this.mcpApi, 32000, (name, reason) => {
            sourceStatus[name] = `unavailable: ${reason}`;
          });
        } catch {
          for (const name of routine.allowed_tools.filter((item) => item.includes("__")))
            sourceStatus[name] = "unavailable: source failed";
        }
      }
      if (toolsAvailable) {
        const availableNames = new Set(mcpTools.map((tool) => tool.name));
        for (const name of routine.allowed_tools.filter((item) => item.includes("__"))) {
          if (!availableNames.has(name)) sourceStatus[name] = "unavailable: needs approval";
        }
      }
      const registry = createToolRegistry({
        database,
        allowedTools: routine.allowed_tools,
        finishRun: (signal) => {
          finishRun = signal;
        },
        onUnavailable: (name) => {
          sourceStatus[name] = "unavailable";
        },
        mcpTools,
      });
      const context = {
        messageId: job.id,
        toolCallId: "",
        signal: new AbortController().signal,
        onApprovalRequested: () => {},
        onHoldDelivery: () => {},
        claimTurnSlot: () => true,
        releaseTurnSlot: () => {},
      };
      const prep = job.trigger === "before_event" ? eventContext(database, job.eventId) : null;
      if (prep?.status === "unavailable") sourceStatus.event_history = "unavailable";
      const triggerContext = job.trigger === "meeting_ended" ? meetingContext(database, job.sourceNoteId) : prep?.text || "";
      const prompt = `${routine.prompt}\n\n${triggerContext ? `${triggerContext}\n\n` : ""}${calendar ? `Today's calendar:\n${calendar.text}\n\n` : ""}${actions ? `Last seven days' checkbox action items:\n${actions.text}\n\n` : ""}${selectedNotes ? `Selected notes (deterministically filtered):\n${selectedNotes.text}\n\n` : ""}Cite notes with Markdown links in the form [Note](note:<id>). Do not invent unavailable sources. ${toolsAvailable ? "Write the note text, then call finish_run with empty=false and a short headline. If there is truly nothing to report, call finish_run with empty=true." : "End with a short useful answer or exactly NOTHING_TO_REPORT."}`;
      const response = await this.infer({ model, prompt, toolsAvailable, registry, context });
      if (toolsAvailable && !response.toolsAvailable) {
        for (const name of routine.allowed_tools)
          sourceStatus[name] = "unavailable: endpoint did not attach tools";
      }
      const result = completion({
        text: response.text,
        finishRun,
        toolsAvailable: response.toolsAvailable ?? false,
      });
      if (result.status === "empty" || result.status === "failed") {
        database.updateRoutineRun(job.id, {
          status: result.status,
          source_status: JSON.stringify(sourceStatus),
          ended_at: new Date().toISOString(),
        });
        return result;
      }
      let folder = database
        .getFolders(routine.space_id)
        .find((item) => item.routine_id === routine.id);
      if (!folder) {
        const created = database.createFolder(routine.name, routine.space_id);
        if (!created.success) throw new Error(created.error);
        folder = created.folder;
        database.db
          .prepare("UPDATE folders SET routine_id=? WHERE id=?")
          .run(routine.id, folder.id);
      }
      const unavailable = Object.entries(sourceStatus)
        .filter(([, value]) => typeof value === "string" && value.startsWith("unavailable"))
        .map(([name]) => name.replaceAll("_", " "));
      const sourceParts = [
        ...(actions ? [`${actions.scanned} notes scanned, ${actions.matched} with checkboxes`] : []),
        ...(calendar ? [`calendar ${calendar.status}`] : []),
        ...(unavailable.length ? [`unavailable: ${unavailable.join(", ")}`] : []),
        ...(modelWarning ? [modelWarning] : []),
      ];
      const sourceLine = sourceParts.length ? `Sources: ${sourceParts.join("; ")}` : "";
      const note = database.saveNote(
        noteTitle(database, routine, now),
        `${linkNoteReferences(result.text)}${sourceLine ? `\n\n${sourceLine}` : ""}`,
        "personal",
        null,
        null,
        folder.id,
        routine.space_id
      ).note;
      const status = unavailable.length > 0 || result.status === "partial" ? "partial" : "done";
      database.updateRoutineRun(job.id, {
        status,
        note_id: note.id,
        source_status: JSON.stringify(sourceStatus),
        ended_at: new Date().toISOString(),
      });
      try {
        this.notify({
          routine,
          note,
          folder,
          status,
          headline: result.headline,
          sourceStatus,
          confirmationSkipped: result.status === "partial",
        });
      } catch {
        /* Notification delivery cannot undo a saved note. */
      }
      return { status, note };
    } catch (error) {
      database.updateRoutineRun(job.id, {
        status: "failed",
        error: error.message,
        ended_at: new Date().toISOString(),
      });
      return { status: "failed", error: error.message };
    }
  }
}

module.exports = { RoutineRunner, actionItemContext, selectedNoteContext, calendarContext, eventContext, linkNoteReferences };
