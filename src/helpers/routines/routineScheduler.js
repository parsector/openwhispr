const { randomUUID } = require("crypto");
const { nextRun, latestCatchUp, manualSlotKey } = require("./routineSchedulePolicy");
const debugLogger = require("../debugLogger");
const { matchesBeforeEvent, matchesMeetingEnded, PROVIDERS } = require("./routineEventTriggers");

function storedInstant(value) {
  if (!value) return 0;
  const text = String(value);
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(text) ? text : `${text.replace(" ", "T")}Z`) || 0;
}

class RoutineScheduler {
  constructor({ database, queue, modelChoice, onRunFinished = () => {}, meetingWaitMs = 90000 }) {
    this.database = database;
    this.queue = queue;
    this.modelChoice = modelChoice;
    this.onRunFinished = onRunFinished;
    this.meetingWaitMs = meetingWaitMs;
    this.timer = null;
    this.interval = null;
    this.eventTimers = new Map();
    this.waitingNotes = new Map();
    this.finalizedNotes = new Map();
  }

  start() {
    this.database.db
      .prepare(
        "UPDATE routine_runs SET status='failed', error='App closed during run', ended_at=? WHERE status='running'"
      )
      .run(new Date().toISOString());
    this.database.db.prepare("UPDATE routine_runs SET status='failed', error='App closed while waiting for meeting note', ended_at=? WHERE status='queued' AND trigger='meeting_ended'").run(new Date().toISOString());
    this.check();
    this.interval = setInterval(() => {
      this.check();
      this.queue.drain();
    }, 30000);
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.interval);
    for (const plan of this.eventTimers.values()) clearTimeout(plan.timer);
    this.eventTimers.clear();
    for (const wait of this.waitingNotes.values()) clearTimeout(wait.timer);
    this.waitingNotes.clear();
    this.finalizedNotes.clear();
  }
  wake() {
    this.check();
  }

  check() {
    clearTimeout(this.timer);
    const now = new Date();
    let soonest = Infinity;
    for (const routine of this.database.listRoutines()) {
      try {
        if (routine.paused || routine.trigger_type !== "time") continue;
        const after = new Date(storedInstant(routine.updated_at || routine.created_at));
        const missed = latestCatchUp(
          routine.trigger_config,
          now,
          routine.catch_up_window_hours,
          after
        );
        if (missed)
          this.enqueue(
            routine,
            missed.slotKey,
            true,
            missed.at.getTime() + routine.catch_up_window_hours * 3600000
          );
        const next = nextRun(routine.trigger_config, now);
        if (next) {
          soonest = Math.min(soonest, next.at.getTime());
          this.database.db
            .prepare("UPDATE routines SET next_run_at=? WHERE id=?")
            .run(next.at.toISOString(), routine.id);
        }
      } catch (error) {
        debugLogger.warn("Routine schedule check failed", {
          routineId: routine.id,
          error: error.message,
        });
      }
    }
    this.checkEvents(now);
    if (Number.isFinite(soonest)) {
      this.timer = setTimeout(
        () => this.check(),
        Math.max(1000, Math.min(soonest - Date.now() + 100, 2147483647))
      );
    }
  }

  checkEvents(now = new Date()) {
    const plans = new Map();
    const routines = this.database.listRoutines().filter((routine) => !routine.paused && routine.trigger_type === "before_event");
    if (routines.length) {
      const maxWindow = Math.max(...routines.map((routine) => routine.catch_up_window_hours));
      const events = this.database.getCalendarEventsInRange(new Date(now.getTime() - maxWindow * 3600000).toISOString(), new Date(now.getTime() + 7 * 86400000).toISOString(), PROVIDERS);
      for (const routine of routines) for (const event of events) {
        if (!matchesBeforeEvent(routine.trigger_config, event)) continue;
        const due = Date.parse(event.start_time) - routine.trigger_config.minutes_before * 60000;
        if (!Number.isFinite(due) || now.getTime() > due + routine.catch_up_window_hours * 3600000) continue;
        const key = `${routine.id}:event:${event.id}`;
        plans.set(key, { routine, event, due });
      }
    }
    for (const routine of routines) {
      const future = [...plans.values()].filter((plan) => plan.routine.id === routine.id && plan.due > now.getTime());
      const next = future.length ? new Date(Math.min(...future.map((plan) => plan.due))).toISOString() : null;
      this.database.db.prepare("UPDATE routines SET next_run_at=? WHERE id=?").run(next, routine.id);
    }
    const cancelled = new Set();
    for (const [key, old] of this.eventTimers) {
      const next = plans.get(key);
      if (next && next.due === old.due &&
        next.routine.updated_at === old.routine.updated_at &&
        next.routine.catch_up_window_hours === old.routine.catch_up_window_hours) continue;
      clearTimeout(old.timer);
      this.eventTimers.delete(key);
      cancelled.add(key);
      this.queue.cancelSlot(old.routine.id, `event:${old.event.id}`);
      const pending = this.database.db.prepare("SELECT id,status FROM routine_runs WHERE routine_id=? AND slot_key=?").get(old.routine.id, `event:${old.event.id}`);
      if (pending?.status === "queued") this.database.updateRoutineRun(pending.id, { status: "skipped", error: "cancelled", ended_at: new Date().toISOString() });
    }
    for (const [key, plan] of plans) {
      if (this.eventTimers.has(key)) continue;
      const fire = () => {
        // Keep the fired plan until a sync changes or removes the event. A
        // routine may still be queued behind another run when that happens.
        this.eventTimers.set(key, { ...plan, timer: null });
        if (Date.now() > plan.due + plan.routine.catch_up_window_hours * 3600000) return;
        const liveRoutine = this.database.getRoutine(plan.routine.id);
        if (!liveRoutine || liveRoutine.paused || liveRoutine.trigger_type !== "before_event") return;
        const current = this.database.getCalendarEventsInRange(
          new Date(Math.min(plan.due, Date.now()) - 86400000).toISOString(),
          new Date(Date.now() + 7 * 86400000).toISOString(), PROVIDERS
        ).find((event) => event.id === plan.event.id);
        if (!matchesBeforeEvent(liveRoutine.trigger_config, current) ||
          Date.parse(current.start_time) - liveRoutine.trigger_config.minutes_before * 60000 !== plan.due) return;
        const previous = this.database.db.prepare("SELECT id,status,error FROM routine_runs WHERE routine_id=? AND slot_key=?").get(plan.routine.id, `event:${plan.event.id}`);
        if (previous?.status === "skipped" && previous.error === "cancelled")
          this.database.updateRoutineRun(previous.id, { status: "queued", error: null, ended_at: null });
        void this.enqueue(liveRoutine, `event:${plan.event.id}`, true, plan.due + liveRoutine.catch_up_window_hours * 3600000, randomUUID(), "before_event", { eventId: plan.event.id });
      };
      if (plan.due <= now.getTime()) {
        if (cancelled.has(key)) queueMicrotask(fire);
        else fire();
      }
      else this.eventTimers.set(key, { ...plan, timer: setTimeout(fire, Math.min(plan.due - now.getTime(), 2147483647)) });
    }
  }

  meetingStopped(noteId) {
    const note = this.database.getNote(noteId);
    if (!note) return;
    if (this.database.db.prepare("SELECT 1 FROM routine_runs WHERE note_id=? LIMIT 1").get(noteId)) return;
    const event = note.calendar_event_id ? this.database.getCalendarEventById(note.calendar_event_id) : null;
    for (const routine of this.database.listRoutines()) {
      if (routine.paused || routine.trigger_type !== "meeting_ended" || !matchesMeetingEnded(routine.trigger_config, note, event)) continue;
      const slotKey = `note:${noteId}`;
      const row = this.database.claimRoutineRun(routine.id, slotKey, "meeting_ended");
      if (row.status !== "queued") continue;
      this.database.updateRoutineRun(row.id, { source_note_id: noteId });
      const key = `${routine.id}:${noteId}`;
      if (this.waitingNotes.has(key)) continue;
      const timer = setTimeout(() => this.finishMeetingWait(key, "pending"), this.meetingWaitMs);
      this.waitingNotes.set(key, { routine, row, timer, stoppedAt: Date.now() });
      if (this.finalizedNotes.has(noteId)) this.finishMeetingWait(key, this.finalizedNotes.get(noteId));
    }
    this.finalizedNotes.delete(noteId);
  }

  meetingFinalized(noteId, diarized) {
    const status = diarized === true ? "ok" : diarized === false ? "failed" : "skipped";
    this.finalizedNotes.set(noteId, status);
    let matched = false;
    for (const key of this.waitingNotes.keys()) if (key.endsWith(`:${noteId}`)) {
      matched = true;
      this.finishMeetingWait(key, status);
    }
    if (matched) this.finalizedNotes.delete(noteId);
  }

  finishMeetingWait(key, status) {
    const wait = this.waitingNotes.get(key);
    if (!wait) return;
    clearTimeout(wait.timer);
    this.waitingNotes.delete(key);
    this.database.updateRoutineRun(wait.row.id, { source_status: JSON.stringify({ diarization: status }) });
    void this.enqueue(wait.routine, `note:${wait.row.source_note_id || key.split(":").at(-1)}`, true, wait.stoppedAt + wait.routine.catch_up_window_hours * 3600000, wait.row.id, "meeting_ended", { sourceNoteId: wait.row.source_note_id || Number(key.split(":").at(-1)), diarization: status });
  }

  enqueue(routine, slotKey, catchUp = false, expiresAt = Infinity, id = randomUUID(), trigger = catchUp ? "time" : "manual", extra = {}) {
    const row = this.database.claimRoutineRun(routine.id, slotKey, trigger, id);
    if (row.status !== "queued") return Promise.resolve(row);
    if (extra.eventId) this.database.updateRoutineRun(row.id, { event_id: extra.eventId });
    if (extra.sourceNoteId) this.database.updateRoutineRun(row.id, { source_note_id: extra.sourceNoteId });
    const model = this.modelChoice();
    return this.queue
      .enqueue({
        id: row.id,
        routineId: routine.id,
        slotKey,
        catchUp,
        expiresAt,
        localModel: model?.mode === "local",
        model,
        trigger,
        ...extra,
      })
      .then((result) => {
        if (result?.status === "skipped")
          this.database.updateRoutineRun(row.id, {
            status: "skipped",
            error: result.reason,
            ended_at: new Date().toISOString(),
          });
        this.onRunFinished();
        return result;
      })
      .catch((error) => {
        this.database.updateRoutineRun(row.id, {
          status: "failed",
          error: error.message,
          ended_at: new Date().toISOString(),
        });
        this.onRunFinished();
        return { status: "failed", error: error.message };
      });
  }

  runNow(id) {
    const routine = this.database.getRoutine(id);
    if (!routine) throw new Error("Routine not found");
    const runId = randomUUID();
    return this.enqueue(routine, manualSlotKey(runId), false, Infinity, runId);
  }
}

module.exports = { RoutineScheduler };
