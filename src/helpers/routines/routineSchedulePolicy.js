// Local wall-clock schedules deliberately use Date's normalization of missing
// spring-forward minutes. A slot key uses the requested time, not that instant.
function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function slotKey(date, time) {
  return `${localDate(date)} ${time}`;
}

function manualSlotKey(runId) {
  return `manual:${runId}`;
}

function voiceSlotKey(runId) {
  return `voice:${runId}`;
}

function validateSchedule(config) {
  const slots = config?.slots;
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > 6) {
    throw new Error("Choose between 1 and 6 time slots");
  }
  for (const slot of slots) {
    if (
      !Array.isArray(slot.days) ||
      !slot.days.length ||
      slot.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time)
    ) {
      throw new Error("Invalid time slot");
    }
  }
  return slots;
}

function occurrences(config, start, end) {
  const slots = validateSchedule(config);
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const result = new Map();
  while (day.getTime() <= end.getTime()) {
    for (const slot of slots) {
      if (!slot.days.includes(day.getDay())) continue;
      const [hour, minute] = slot.time.split(":").map(Number);
      const when = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
      const key = slotKey(day, slot.time);
      if (when > start && when <= end && !result.has(key))
        result.set(key, { at: when, slotKey: key });
    }
    day.setDate(day.getDate() + 1);
  }
  return [...result.values()].sort((a, b) => a.at - b.at || a.slotKey.localeCompare(b.slotKey));
}

function nextRun(config, now = new Date()) {
  return occurrences(config, now, new Date(now.getTime() + 8 * 86400000))[0] || null;
}

function latestCatchUp(config, now = new Date(), hours = 4, after = null) {
  const start = new Date(Math.max(now.getTime() - hours * 3600000, after?.getTime() ?? -Infinity));
  return occurrences(config, start, now).at(-1) || null;
}

module.exports = {
  localDate,
  slotKey,
  manualSlotKey,
  voiceSlotKey,
  validateSchedule,
  occurrences,
  nextRun,
  latestCatchUp,
};
