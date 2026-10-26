const { getMeetingJoinUrl } = require("../meetingJoinUrl");

const DAY = 86400000;
const PROVIDERS = ["google", "microsoft", "apple"];

function titleMatches(pattern, title) {
  return !pattern || String(title || "").toLocaleLowerCase().includes(pattern.toLocaleLowerCase());
}

function matchesBeforeEvent(config, event) {
  if (!event || event.status === "cancelled" || event.is_all_day) return false;
  if (config.skip_declined && event.self_response_status === "declined") return false;
  if (!titleMatches(config.title_pattern, event.summary)) return false;
  if (config.has_attendees && !(Number(event.attendees_count) > 0)) return false;
  if (config.has_meeting_link && !getMeetingJoinUrl(event)) return false;
  return true;
}

function matchesMeetingEnded(config, note, event) {
  if (!note || note.deleted_at) return false;
  if (config.folder_ids.length && !config.folder_ids.includes(note.folder_id)) return false;
  if (config.title_pattern && !titleMatches(config.title_pattern, event?.summary)) return false;
  return true;
}

function validateEventTrigger(type, config) {
  if (!config || config.schema_version !== 1) throw new Error("Invalid trigger configuration");
  if (type === "before_event") {
    if (!Number.isInteger(config.minutes_before) || config.minutes_before < 0 || config.minutes_before > 1440 ||
      typeof config.title_pattern !== "string" || config.title_pattern.length > 200 ||
      typeof config.has_attendees !== "boolean" || typeof config.has_meeting_link !== "boolean" ||
      typeof config.skip_declined !== "boolean") throw new Error("Invalid calendar trigger");
  } else if (type === "meeting_ended") {
    if (!Array.isArray(config.folder_ids) || config.folder_ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
      typeof config.title_pattern !== "string" || config.title_pattern.length > 200 ||
      (!config.folder_ids.length && !config.title_pattern.trim())) throw new Error("Choose a folder or title filter");
  } else if (type !== "time") throw new Error("Invalid trigger type");
}

function meetingEndedPreview(database, config, now = Date.now()) {
  const events = database.getCalendarEventsInRange(new Date(now - 7 * DAY).toISOString(), new Date(now).toISOString(), PROVIDERS);
  const scope = database._accountScopeCondition("notes");
  const notes = database.db.prepare(`SELECT id,folder_id,calendar_event_id,deleted_at FROM notes WHERE deleted_at IS NULL AND ${scope.sql}
    AND id NOT IN (SELECT note_id FROM routine_runs WHERE note_id IS NOT NULL)`).all(...scope.params);
  const byEvent = new Map();
  for (const note of notes) {
    if (!byEvent.has(note.calendar_event_id)) byEvent.set(note.calendar_event_id, []);
    byEvent.get(note.calendar_event_id).push(note);
  }
  return events.filter((event) => {
    const candidates = byEvent.get(event.id) || (config.folder_ids.length ? [] : [{ folder_id: null }]);
    return candidates.some((note) => matchesMeetingEnded(config, note, event));
  }).length;
}

module.exports = { matchesBeforeEvent, matchesMeetingEnded, validateEventTrigger, meetingEndedPreview, PROVIDERS };
