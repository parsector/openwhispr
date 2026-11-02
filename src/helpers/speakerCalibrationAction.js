const { randomUUID } = require("node:crypto");
const thresholds = require("./speakerDecisionThresholds");
const history = require("./speakerGlobalHistory");
function ensure(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS speaker_calibration_actions (
    id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
}
function apply(database, report) {
  const db = database.db;
  ensure(db);
  if (
    !report ||
    report.version !== 2 ||
    report.method !== "stored-centroid-current-profiles" ||
    !Object.keys(report.recommended || {}).length ||
    Object.keys(report.recommended).some(
      (key) => !["similarityFloor", "runnerUpMargin"].includes(key)
    )
  )
    throw Error("No supported in-app calibration recommendation");
  const previous = thresholds.current();
  const values = { ...previous.values, ...report.recommended };
  const id = randomUUID();
  let next;
  try {
    next = db.transaction(() => {
      const applied = thresholds.apply(values, report);
      const snapshot = {
        previous,
        next: applied,
        reportId: report.id,
        revisions: report.evidence.revisions,
        fingerprints: report.fingerprints,
        exclusions: report.evidence.exclusions,
      };
      db.prepare("INSERT INTO speaker_calibration_actions (id, snapshot) VALUES (?, ?)").run(
        id,
        JSON.stringify(snapshot)
      );
      history.add(db, { id, kind: "calibration", label: "Speaker calibration" });
      return applied;
    })();
  } catch (error) {
    thresholds.restore(previous);
    throw error;
  }
  return { success: true, id, ...next };
}
function undo(database, id) {
  const db = database.db;
  ensure(db);
  if (history.latest(db)?.id !== id || !history.canUndo(db, id))
    return { success: false, error: "later_change" };
  const action = db
    .prepare("SELECT snapshot FROM speaker_calibration_actions WHERE id = ?")
    .get(id);
  if (!action) return { success: false, error: "action_missing" };
  const snapshot = JSON.parse(action.snapshot);
  const beforeUndo = thresholds.current();
  let result;
  try {
    result = db.transaction(() => {
      const restored = thresholds.restore(snapshot.previous);
      db.prepare("DELETE FROM speaker_calibration_actions WHERE id = ?").run(id);
      history.remove(db, id);
      return restored;
    })();
  } catch (error) {
    thresholds.restore(beforeUndo);
    throw error;
  }
  return { success: true, ...result };
}
module.exports = { apply, undo };
