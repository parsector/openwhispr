const { localDate } = require("./routineSchedulePolicy");

const TIME_TITLE_TEMPLATE = "{name} — {date}";
const EVENT_TITLE_TEMPLATE = "{name} — {event} — {date}";
const MAX_TITLE_LENGTH = 200;

function defaultTitleTemplate(triggerType) {
  return triggerType === "before_event" || triggerType === "meeting_ended"
    ? EVENT_TITLE_TEMPLATE : TIME_TITLE_TEMPLATE;
}

function normalizeTitleTemplate(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 1000)
    throw new Error("Invalid title template");
  return value.trim();
}

function capTitle(title) {
  if (title.length <= MAX_TITLE_LENGTH) return title;
  const prefix = title.slice(0, MAX_TITLE_LENGTH + 1);
  const boundary = prefix.lastIndexOf(" ");
  return (boundary > 0 ? prefix.slice(0, boundary) : title.slice(0, MAX_TITLE_LENGTH)).trimEnd();
}

function renderRoutineTitle({ name, triggerType, titleTemplate, event, now = new Date() }) {
  const date = localDate(new Date(now));
  const eventName = triggerType === "time" ? "" : (typeof event === "string" ? event.trim() : "");
  const configured = (typeof titleTemplate === "string" && titleTemplate.trim()) || defaultTitleTemplate(triggerType);
  // A missing event only invalidates templates that need its value.
  const template = !eventName && configured.includes("{event}") ? TIME_TITLE_TEMPLATE : configured;
  const title = template.replace(/\{(name|event|date)\}/g, (_, token) =>
    ({ name: String(name || "").trim(), event: eventName, date })[token]);
  return capTitle(title.replace(/\s+/g, " ").trim() || `${name} — ${date}`);
}

module.exports = { defaultTitleTemplate, normalizeTitleTemplate, renderRoutineTitle };
