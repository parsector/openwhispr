const { parseDueDate } = require("./parseDueDate");
const { normaliseText, shouldMerge, matchCompletion } = require("./matching");
const { CommitmentStore } = require("./store");

const VERSION = "slice1-v1";
const MARKER = "__OPENWHISPR_COMMITMENTS_COMPLETE__";
const ITEM_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    quote: { type: "string" },
    segment_index: { type: "integer" },
    person: { type: ["string", "array", "null"] },
    direction: { type: "string" },
    due_raw: { type: ["string", "null"] },
    kind: { type: "string" },
    strength: { type: ["string", "null"] },
  },
  required: ["text", "quote", "segment_index", "kind"],
  additionalProperties: false,
};
const RESPONSE_FORMAT = {
  type: "json_object",
  schema: {
    type: "object",
    properties: {
      items: { type: "array", items: ITEM_SCHEMA },
    },
    required: ["items"],
    additionalProperties: false,
  },
};

function parseSegments(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (
      !Array.isArray(parsed) ||
      !parsed.some((part) => typeof part?.text === "string" && part.text.trim())
    )
      return [];
    return parsed.map((part) => (part && typeof part.text === "string" ? part : { text: "" }));
  } catch {
    return [];
  }
}

function windows(segments, maxChars = 8000) {
  const result = [];
  let start = 0;
  while (start < segments.length) {
    let end = start,
      length = 0;
    while (
      end < segments.length &&
      (end === start || length + segments[end].text.length < maxChars)
    ) {
      length += segments[end].text.length;
      end++;
    }
    result.push(
      segments.slice(start, end).map((part, offset) => ({ ...part, segment_index: start + offset }))
    );
    if (end === segments.length) break;
    start = Math.max(start + 1, end - 1);
  }
  return result;
}

function parseResponse(raw, local) {
  if (raw && typeof raw === "object" && typeof raw.text === "string") raw = raw.text;
  if (typeof raw !== "string") throw new Error("Malformed commitments response");
  let body = raw.trim();
  if (!local) {
    if (!body.endsWith(MARKER)) throw new Error("Incomplete commitments response");
    body = body.slice(0, -MARKER.length).trim();
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Malformed commitments JSON");
  }
  if (!parsed || !Array.isArray(parsed.items)) throw new Error("Malformed commitments envelope");
  if (
    parsed.items.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        typeof item.text !== "string" ||
        typeof item.quote !== "string" ||
        !Number.isSafeInteger(item.segment_index) ||
        !["new", "completion"].includes(item.kind)
    )
  )
    throw new Error("Malformed commitments item");
  return parsed.items;
}

function hasVerb(text) {
  return /\b(send|sent|share|shared|deliver|delivered|finish|finished|complete|completed|review|reviewed|write|wrote|prepare|prepared|schedule|scheduled|call|called|email|emailed|follow|followed|update|updated|create|created|fix|fixed|pay|paid|book|booked|ship|shipped|draft|drafted|check|checked|get|got|make|made|provide|provided|confirm|confirmed|do|did|submit|submitted|file|filed|build|built|discuss|discussed|ask|asked)\b/i.test(
    text
  );
}

function validItem(item, segments) {
  const segment = segments[item.segment_index];
  if (!segment || !segment.text.includes(item.quote) || !item.quote.trim()) return false;
  if (normaliseText(item.text).split(/\s+/).length < 3 || !hasVerb(item.text)) return false;
  if (
    item.person != null &&
    typeof item.person !== "string" &&
    !(Array.isArray(item.person) && item.person.every((name) => typeof name === "string"))
  )
    return false;
  return (
    item.kind !== "completion" || !/\b(?:think|maybe|probably|perhaps|might)\b/i.test(item.quote)
  );
}

async function extractCommitments({ note, database, model, infer }) {
  const segments = parseSegments(note?.transcript);
  if (!segments.length) return { created: 0, proposals: 0, skipped: true };
  if (!model?.model) throw new Error("No routines model selected");
  const local = model.mode === "local";
  const all = [];
  for (const window of windows(segments)) {
    const prompt = `Extract all concrete meeting commitments and explicit completion claims. Return only JSON {"items":[{"text":"action","quote":"exact substring","segment_index":0,"person":null,"direction":"owe","due_raw":null,"kind":"new","strength":null}]}. Use the original segment_index values. A commitment to two people has one item and person is an array. "waiting" means another person owes the user. Exclude vague suggestions and hedged completion claims. Never invent dates.\n${JSON.stringify(window)}${local ? "" : `\nAppend ${MARKER} immediately after the JSON.`}`;
    const response = await infer({
      model,
      prompt,
      systemPrompt: "Return only the requested JSON object.",
      responseFormat: local ? RESPONSE_FORMAT : undefined,
      maxTokens: 4000,
    });
    all.push(...parseResponse(response, local));
  }
  const store = new CommitmentStore(database);
  const distinct = new Set();
  const items = all
    .filter((item) => validItem(item, segments))
    .filter((item) => {
      const key = `${item.kind}:${item.segment_index}:${item.quote}`;
      if (distinct.has(key)) return false;
      distinct.add(key);
      return true;
    });
  const apply = database.db.transaction(() => {
    // Re-extraction removes only untouched rows created solely by this note.
    const old = database.db
      .prepare("SELECT * FROM commitments WHERE source_note_id=? AND account_id IS ?")
      .all(String(note.id), store.scope());
    for (const row of old) {
      if (row.pinned_fields && row.pinned_fields !== "[]") continue;
      if (!["open", "proposed"].includes(row.status)) continue;
      const external = database.db
        .prepare(
          "SELECT 1 FROM commitment_mentions WHERE commitment_id=? AND note_id IS NOT ? LIMIT 1"
        )
        .get(row.id, String(note.id));
      const pending = database.db
        .prepare(
          "SELECT 1 FROM commitment_proposals WHERE commitment_id=? AND status='pending' LIMIT 1"
        )
        .get(row.id);
      if (external || pending) continue;
      database.db.prepare("DELETE FROM commitment_proposals WHERE commitment_id=?").run(row.id);
      database.db.prepare("DELETE FROM commitment_mentions WHERE commitment_id=?").run(row.id);
      database.db.prepare("DELETE FROM commitments WHERE id=?").run(row.id);
    }
    // Rows retained because of edits, other meetings or a pending review keep
    // their evidence and original expiry when this note is processed again.
    const preservedMentions = database.db
      .prepare(
        `SELECT m.* FROM commitment_mentions m
      JOIN commitments c ON c.id=m.commitment_id WHERE m.note_id=? AND c.account_id IS ?
      `
      )
      .all(String(note.id), store.scope());
    const preservedKeys = new Set(
      preservedMentions.map(
        (mention) =>
          `${mention.kind === "completion_proposed" ? "completion" : "new"}:${mention.segment_index}:${mention.quote}`
      )
    );
    let created = 0,
      proposals = 0;
    const anchored = new Date(note.created_at || Date.now());
    for (const item of items) {
      if (preservedKeys.has(`${item.kind}:${item.segment_index}:${item.quote}`)) continue;
      const text = normaliseText(item.text);
      const person = item.person || null;
      const rows = store.list();
      if (item.kind === "completion") {
        const match = matchCompletion(text, rows, person);
        if (!match) continue;
        const proposal = store.propose(match.id, {
          note_id: note.id,
          segment_index: item.segment_index,
          quote: item.quote,
          strength: item.strength === "second_hand" ? "second_hand" : "explicit",
        });
        if (proposal) proposals++;
        continue;
      }
      const candidate = {
        text,
        person,
        direction: item.direction === "waiting" ? "waiting" : "owe",
      };
      const match = rows.find((row) => shouldMerge(row, candidate));
      const date = item.due_raw ? parseDueDate(item.due_raw, anchored) : null;
      if (match) {
        store.restate(match.id, {
          note_id: note.id,
          segment_index: item.segment_index,
          quote: item.quote,
        });
        if (date) store.update(match.id, { due_date: date.due_date, due_raw: item.due_raw });
        continue;
      }
      const segment = segments[item.segment_index];
      store.create({
        ...candidate,
        ...date,
        due_raw: item.due_raw || null,
        quote: item.quote,
        quote_segment_index: item.segment_index,
        source_note_id: note.id,
        source_note_title: note.title,
        space_id: note.space_id,
        speaker_confidence:
          segment.speaker === "you" && segment.source === "mic" ? "attributed" : "unattributed",
        extraction_version: VERSION,
      });
      created++;
    }
    return { created, proposals, skipped: false };
  });
  return apply();
}

module.exports = {
  extractCommitments,
  parseSegments,
  windows,
  parseResponse,
  RESPONSE_FORMAT,
  MARKER,
};
