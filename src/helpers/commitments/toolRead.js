const { CommitmentStore, isOverdue, localToday } = require("./store");

const MAX_PAYLOAD = 8000;
const defs = require("./todoToolDefinitions.json");
const listDefinition = defs.list;
const definitions = [defs.list, defs.get];

function validateList(args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !(key in listDefinition.parameters.properties))) throw new Error("Invalid todo filters");
  const { status = "open", direction = "both", due = "all", person, limit = 20, include_archived = false } = args;
  if (!["open", "proposed", "completed", "rejected", "all"].includes(status) || !["owe", "waiting", "both"].includes(direction) || !["overdue", "today", "week", "none", "all"].includes(due) || (person !== undefined && (typeof person !== "string" || person.length > 200)) || !Number.isSafeInteger(limit) || limit < 1 || typeof include_archived !== "boolean") throw new Error("Invalid todo filters");
  return { status, direction, due, person, limit: Math.min(limit, 50), include_archived };
}

function visible(row, spaces) {
  return row.space_id == null || spaces.has(String(row.space_id));
}

function dueMatches(row, due, now, today) {
  if (due === "all") return true;
  if (due === "none") return !row.due_date;
  if (due === "overdue") return !!isOverdue(row, now);
  if (due === "today") return row.due_date === today;
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 6);
  return !!row.due_date && row.due_date >= today && row.due_date <= localToday(end);
}

function personMatches(value, query) {
  if (!query) return true;
  return String(value || "").toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function order(row, now) {
  if (row.direction === "waiting") return 4;
  if (isOverdue(row, now)) return 0;
  if (!row.due_date) return 3;
  if (row.due_date <= localToday(now)) return 1;
  return 2;
}

function capTodoResult(result) {
  const copy = JSON.parse(JSON.stringify(result));
  const size = () => JSON.stringify(copy).length;
  if (size() <= MAX_PAYLOAD) return copy;
  copy.truncated = true;
  if (Array.isArray(copy.data)) {
    for (const row of copy.data) for (const key of ["text", "person", "source_meeting_title"]) {
      if (typeof row[key] === "string" && row[key].length > 500) row[key] = row[key].slice(0, 500) + "…";
    }
    while (copy.data.length && size() > MAX_PAYLOAD) copy.data.pop();
  } else if (copy.data) {
    for (const field of ["quote", "text", "person", "source_note_title", "rejected_reason"]) {
      if (typeof copy.data[field] === "string" && copy.data[field].length > 1000) copy.data[field] = copy.data[field].slice(0, 1000) + "…";
    }
    while (copy.data.mentions?.length && size() > MAX_PAYLOAD) copy.data.mentions.shift();
    for (const field of ["quote", "text", "person", "source_note_title", "rejected_reason"]) {
      while (typeof copy.data[field] === "string" && size() > MAX_PAYLOAD) copy.data[field] = copy.data[field].slice(0, Math.max(0, copy.data[field].length - 500));
    }
  }
  if (size() > MAX_PAYLOAD) return { success: copy.success, data: { id: copy.data?.id, truncated: true }, displayText: copy.displayText, truncated: true };
  return copy;
}

function listTodos(database, args = {}, now = new Date()) {
  const filters = validateList(args);
  const store = new CommitmentStore(database);
  const spaces = new Set(database.getSpaces().map((space) => String(space.id)));
  const rows = store.list(false).concat(filters.include_archived ? store.list(true) : []);
  const today = localToday(now);
  const filtered = rows.filter((row) => visible(row, spaces) &&
    (filters.status === "all" || row.status === filters.status) &&
    (filters.direction === "both" || row.direction === filters.direction) &&
    personMatches(row.person, filters.person) && dueMatches(row, filters.due, now, today));
  filtered.sort((a, b) => order(a, now) - order(b, now) ||
    (a.due_date || "9999").localeCompare(b.due_date || "9999") ||
    String(a.created_at).localeCompare(String(b.created_at)));
  return capTodoResult({ success: true, data: filtered.slice(0, filters.limit).map((row) => ({
    id: row.id, text: row.text, person: row.person, direction: row.direction,
    due_date: row.due_date, status: row.status, overdue: !!isOverdue(row, now),
    completed_at: row.completed_at, rejected_at: row.rejected_at, rejected_reason: row.rejected_reason,
    source_meeting_title: row.source_note_title, source: row.source, source_agent: row.source_agent,
    mention_count: row.mention_count,
  })), displayText: `Found ${filtered.length} todo${filtered.length === 1 ? "" : "s"}` });
}

function getTodo(database, args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => key !== "id") || typeof args.id !== "string" || !args.id.trim() || args.id.length > 200) throw new Error("Invalid todo ID");
  const store = new CommitmentStore(database);
  const row = store.get(args.id);
  const spaces = new Set(database.getSpaces().map((space) => String(space.id)));
  if (!row || row.archived_at || !visible(row, spaces)) return { success: false, data: null, displayText: `Todo with ID ${args.id} not found` };
  return todoDetail(store, row);
}

function todoDetail(store, row) {
  const { account_id: _accountId, ...data } = row;
  return capTodoResult({ success: true, data: { ...data, overdue: !!isOverdue(row), mentions: store.mentions(row.id).slice(-10) }, displayText: `Retrieved todo: ${row.id}` });
}

module.exports = { definitions, listTodos, getTodo, capTodoResult, todoDetail };
