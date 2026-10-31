const { CommitmentStore } = require("./store");
const { todoDetail } = require("./toolRead");

const defs = require("./todoToolDefinitions.json");
const definitions = [defs.create, defs.update];

function invalid(message) {
  throw Object.assign(new Error(message), { code: -32602 });
}
function objectArgs(args, allowed) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    invalid("Arguments must be an object.");
  const unknown = Object.keys(args).find((key) => !allowed.includes(key));
  if (unknown) invalid(`Unknown argument "${unknown}". Allowed: ${allowed.join(", ")}.`);
}
function person(value) {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return value.map((item) => item.trim());
  invalid("person must be a string or an array of strings.");
}
function date(value, nullable = false) {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    invalid(
      "due_date must be a real calendar date in yyyy-mm-dd format without a time, or null to clear it on update."
    );
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  )
    invalid(`due_date "${value}" is not a real calendar date; use yyyy-mm-dd.`);
  return value;
}
function validateCreate(args) {
  objectArgs(args, ["text", "person", "direction", "due_date", "quote"]);
  if (typeof args.text !== "string")
    invalid(
      "text is required and must be 1–500 characters after trimming and collapsing newlines."
    );
  const text = args.text.replace(/\s*[\r\n]\s*/g, " ").trim();
  if (!text || text.length > 500)
    invalid("text must be 1–500 characters after trimming and collapsing newlines.");
  if (args.direction !== undefined && !["owe", "waiting"].includes(args.direction))
    invalid('direction must be "owe" or "waiting".');
  if (args.quote !== undefined && (typeof args.quote !== "string" || args.quote.length > 500))
    invalid("quote must be a string of at most 500 characters.");
  return {
    text,
    person: person(args.person),
    direction: args.direction || "owe",
    due_date: args.due_date === undefined ? undefined : date(args.due_date),
    quote: args.quote,
  };
}
function validateUpdate(args) {
  objectArgs(args, ["id", "status", "rejected_reason", "due_date", "person"]);
  if (typeof args.id !== "string" || !args.id.trim() || args.id.length > 200)
    invalid("id must be a nonempty todo ID of at most 200 characters.");
  if (!["status", "rejected_reason", "due_date", "person"].some((key) => Object.hasOwn(args, key)))
    invalid("Provide at least one of status, due_date, or person.");
  if (args.status !== undefined && !["open", "completed", "rejected"].includes(args.status))
    invalid('status must be "open", "completed", or "rejected".');
  if (args.rejected_reason !== undefined && args.status !== "rejected")
    invalid('rejected_reason is allowed only when status is "rejected".');
  if (
    args.rejected_reason !== undefined &&
    (typeof args.rejected_reason !== "string" || args.rejected_reason.length > 500)
  )
    invalid("rejected_reason must be a string of at most 500 characters.");
  return {
    id: args.id,
    ...(args.status !== undefined && { status: args.status }),
    ...(args.rejected_reason !== undefined && { rejected_reason: args.rejected_reason }),
    ...(Object.hasOwn(args, "due_date") && { due_date: date(args.due_date, true) }),
    ...(Object.hasOwn(args, "person") && { person: person(args.person) }),
  };
}
function visible(database, row) {
  return (
    row.space_id == null ||
    new Set(database.getSpaces().map((space) => String(space.id))).has(String(row.space_id))
  );
}
function createTodo(database, args, agent) {
  const input = validateCreate(args);
  const store = new CommitmentStore(database);
  return todoDetail(store, store.create(input, { agent }));
}
function updateTodo(database, args, agent) {
  const { id, due_date, ...patch } = validateUpdate(args);
  const store = new CommitmentStore(database);
  const before = store.get(id);
  if (!before || !visible(database, before))
    return { success: false, data: null, displayText: `Todo with ID ${id} not found` };
  if (
    patch.status === "rejected" &&
    patch.rejected_reason !== undefined &&
    before.status !== "rejected"
  ) {
    let pins = [];
    try {
      pins = JSON.parse(before.pinned_fields || "[]");
    } catch {
      /* malformed legacy pins */
    }
    if (Array.isArray(pins) && pins.includes("status")) delete patch.rejected_reason;
  }
  let after = Object.keys(patch).length ? store.update(id, patch, { agent }) : before;
  if (due_date !== undefined) after = store.setDue(id, due_date, { user: false, agent });
  return todoDetail(store, after);
}

module.exports = { definitions, validateCreate, validateUpdate, createTodo, updateTodo };
