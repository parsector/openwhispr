const { randomUUID } = require("crypto");
const { nextRun, latestCatchUp, manualSlotKey } = require("./routineSchedulePolicy");
const debugLogger = require("../debugLogger");

function storedInstant(value) {
  if (!value) return 0;
  const text = String(value);
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(text) ? text : `${text.replace(" ", "T")}Z`) || 0;
}

class RoutineScheduler {
  constructor({ database, queue, modelChoice, onRunFinished = () => {} }) {
    this.database = database;
    this.queue = queue;
    this.modelChoice = modelChoice;
    this.onRunFinished = onRunFinished;
    this.timer = null;
    this.interval = null;
  }

  start() {
    this.database.db
      .prepare(
        "UPDATE routine_runs SET status='failed', error='App closed during run', ended_at=? WHERE status='running'"
      )
      .run(new Date().toISOString());
    this.check();
    this.interval = setInterval(() => {
      this.check();
      this.queue.drain();
    }, 30000);
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.interval);
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
    if (Number.isFinite(soonest)) {
      this.timer = setTimeout(
        () => this.check(),
        Math.max(1000, Math.min(soonest - Date.now() + 100, 2147483647))
      );
    }
  }

  enqueue(routine, slotKey, catchUp = false, expiresAt = Infinity, id = randomUUID()) {
    const row = this.database.claimRoutineRun(routine.id, slotKey, catchUp ? "time" : "manual", id);
    if (row.status !== "queued") return Promise.resolve(row);
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
