const { localDate } = require("./routineSchedulePolicy");
const { modelSupportsToolCalls } = require("../../utils/modelCapability.ts");
const { createToolRegistry } = require("./routineToolRegistry");

const DAY = 86400000;
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
    const section = `[note:${note.id}] ${note.title} (${note.created_at})\nAttendees: ${note.participants || "none"}\n${lines.join("\n")}`;
    sections.push(section.slice(0, Math.max(0, 60000 - chars)));
    chars += section.length;
  }
  return {
    text: `Action items: ${scanned} notes scanned, ${matched} with checkboxes\n${sections.join("\n\n")}`,
    scanned,
    matched,
  };
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
        related.map((note) => `Related: [note:${note.id}] ${note.title}`).join("\n")
      );
    });
    return { text: lines.join("\n") || "No meetings today", status: "ok" };
  } catch (error) {
    return { text: "Calendar unavailable", status: "unavailable", error: error.message };
  }
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
  constructor({ database, infer, notify = () => {} }) {
    this.database = database;
    this.infer = infer;
    this.notify = notify;
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
      let actions;
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
      const calendar = calendarContext(database, now);
      const sourceStatus = {
        action_items:
          actions.status === "unavailable"
            ? "unavailable"
            : { scanned: actions.scanned, matched: actions.matched },
        calendar: calendar.status,
      };
      const model = job.model;
      const toolsAvailable = Boolean(
        model && modelSupportsToolCalls(model.model, model.provider, model.mode === "local")
      );
      if (!toolsAvailable) {
        for (const name of routine.allowed_tools) sourceStatus[name] = "unavailable";
      }
      let finishRun = null;
      const registry = createToolRegistry({
        database,
        allowedTools: routine.allowed_tools,
        finishRun: (signal) => {
          finishRun = signal;
        },
        onUnavailable: (name) => {
          sourceStatus[name] = "unavailable";
        },
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
      const prompt = `${routine.prompt}\n\nToday's calendar:\n${calendar.text}\n\nLast seven days' checkbox action items:\n${actions.text}\n\nCite notes as note:<id>. Do not invent unavailable sources. ${toolsAvailable && model.mode !== "openwhispr" ? "Write the note text, then call finish_run with empty=false and a short headline. If there is truly nothing to report, call finish_run with empty=true." : "End with a short useful answer or exactly NOTHING_TO_REPORT."}`;
      const response = await this.infer({ model, prompt, toolsAvailable, registry, context });
      if (toolsAvailable && !response.toolsAvailable) {
        for (const name of routine.allowed_tools) sourceStatus[name] = "unavailable";
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
        .filter(([, value]) => value === "unavailable")
        .map(([name]) => name.replaceAll("_", " "));
      const sourceLine = `Sources: ${actions.scanned} notes scanned, ${actions.matched} with checkboxes; calendar ${calendar.status}${unavailable.length ? `; unavailable: ${unavailable.join(", ")}` : ""}`;
      const note = database.saveNote(
        noteTitle(database, routine, now),
        `${result.text}\n\n${sourceLine}`,
        "personal",
        null,
        null,
        folder.id,
        routine.space_id
      ).note;
      const status =
        Object.values(sourceStatus).includes("unavailable") || result.status === "partial"
          ? "partial"
          : "done";
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

module.exports = { RoutineRunner, actionItemContext, calendarContext };
