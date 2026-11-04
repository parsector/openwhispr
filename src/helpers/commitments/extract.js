const { parseDueDate } = require("./parseDueDate");
const { normaliseText, shouldMerge, matchCompletion } = require("./matching");
const { CommitmentStore } = require("./store");
const { parseSegments } = require("./segments");
const fs = require("node:fs");
const path = require("node:path");

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

function responseBody(raw) {
  return raw && typeof raw === "object" && typeof raw.text === "string" ? raw.text : raw;
}

function parseResponse(raw, local) {
  raw = responseBody(raw);
  if (typeof raw !== "string") throw new Error("Malformed commitments response");
  let body = raw.trim();
  if (!local && body.endsWith(MARKER)) {
    body = body.slice(0, -MARKER.length).trim();
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    const unfenced = body
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    const spans = [
      [unfenced.indexOf("{"), unfenced.lastIndexOf("}")],
      [unfenced.indexOf("["), unfenced.lastIndexOf("]")],
    ].filter(([start, end]) => start >= 0 && end > start);
    for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
      try {
        parsed = JSON.parse(unfenced.slice(start, end + 1));
        break;
      } catch {
        /* try the other span */
      }
    }
    if (parsed === undefined) {
      const error = new Error("Malformed commitments JSON");
      error.rawLength = raw.length;
      throw error;
    }
  }
  if (Array.isArray(parsed)) parsed = { items: parsed };
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
  return /\b(send|sent|share|shared|deliver|delivered|finish|finished|complete|completed|review|reviewed|write|wrote|prepare|prepared|schedule|scheduled|call|called|email|emailed|follow|followed|update|updated|create|created|fix|fixed|refine|implement|pay|paid|book|booked|ship|shipped|draft|drafted|check|checked|get|got|make|made|provide|provided|confirm|confirmed|do|did|submit|submitted|file|filed|build|built|discuss|discussed|ask|asked)\b/i.test(
    text
  );
}

function quoteKey(value) {
  return String(value)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function quoteSegmentIndex(item, segments) {
  const current = segments[item.segment_index];
  if (current?.text.includes(item.quote)) return item.segment_index;
  const quote = quoteKey(item.quote);
  if (!quote) return null;
  for (const index of [item.segment_index, item.segment_index - 1, item.segment_index + 1]) {
    if (segments[index] && quoteKey(segments[index].text).includes(quote)) return index;
  }
  return null;
}

function rejectReason(item, segments) {
  const segment = segments[item.segment_index];
  if (!segment || !item.quote.trim()) return "missing_quote_or_segment";
  if (quoteSegmentIndex(item, segments) === null) return "quote_not_found";
  if (normaliseText(item.text).split(/\s+/).length < 3) return "too_few_words";
  if (!hasVerb(item.text)) return "no_action_verb";
  if (
    item.person != null &&
    typeof item.person !== "string" &&
    !(Array.isArray(item.person) && item.person.every((name) => typeof name === "string"))
  )
    return "invalid_person";
  if (item.kind === "completion" && /\b(?:think|maybe|probably|perhaps|might)\b/i.test(item.quote))
    return "hedged_completion";
  return null;
}

function transcriptInfo(raw) {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return {
      transcript_shape: Array.isArray(value)
        ? "array"
        : value === null
          ? "null"
          : typeof value === "object" && Array.isArray(value?.rows)
            ? "rows"
            : typeof value,
      transcript_version:
        value && !Array.isArray(value) && typeof value === "object"
          ? (value.version ?? null)
          : null,
    };
  } catch {
    return { transcript_shape: "invalid_json", transcript_version: null };
  }
}

function writeExtractLog(entry) {
  try {
    const dir = path.join(require("electron").app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "commitments-extract.log"),
      JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n"
    );
  } catch (error) {
    require("../debugLogger").warn(
      "Could not write commitments extraction log",
      { error: error.message },
      "commitments"
    );
  }
}

function safeResponseSnippet(raw) {
  // Preserve the response's shape while ensuring even a partial echoed quote
  // cannot put transcript words in the diagnostic file.
  const safeWords = new Set(["json", "items", "text", "quote", "segment_index", "person", "kind"]);
  return String(raw)
    .slice(0, 300)
    .replace(/[\p{L}\p{N}_]+/gu, (word) => (safeWords.has(word) ? word : "x"));
}

async function extractCommitments({ note, database, model, infer }) {
  const log = {
    note_id: note?.id ?? null,
    ...transcriptInfo(note?.transcript),
    segment_count: 0,
    model_id: model?.model ?? null,
    http_status: null,
    raw_response_length: 0,
    parsed_item_count: 0,
    accepted_count: 0,
    rejected_count: 0,
    rejected_reasons: {},
    created_count: 0,
    proposal_count: 0,
    skip_reason: null,
  };
  let lastResponse = null;
  let segments = [];
  try {
    segments = parseSegments(note?.transcript, note?.id);
    log.segment_count = segments.length;
    if (!segments.length) {
      log.skip_reason = "no_transcript_rows";
      return { created: 0, proposals: 0, skipped: true, reason: log.skip_reason };
    }
    if (!model?.model) {
      log.skip_reason = "no_model";
      return { created: 0, proposals: 0, skipped: true, reason: log.skip_reason };
    }
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
      lastResponse = responseBody(response);
      log.http_status = response?.status ?? 200;
      log.raw_response_length +=
        typeof responseBody(response) === "string" ? responseBody(response).length : 0;
      if (log.http_status >= 400) {
        const error = new Error("Commitments model HTTP error");
        error.status = log.http_status;
        throw error;
      }
      all.push(...parseResponse(response, local));
    }
    log.parsed_item_count = all.length;
    const store = new CommitmentStore(database);
    const distinct = new Set();
    const items = all
      .filter((item) => {
        const reason = rejectReason(item, segments);
        if (reason) {
          log.rejected_count++;
          log.rejected_reasons[reason] = (log.rejected_reasons[reason] || 0) + 1;
        }
        return !reason;
      })
      .map((item) => ({ ...item, segment_index: quoteSegmentIndex(item, segments) }))
      .filter((item) => {
        const key = `${item.kind}:${item.segment_index}:${item.quote}`;
        if (distinct.has(key)) return false;
        distinct.add(key);
        return true;
      });
    log.accepted_count = items.length;
    if (!items.length) {
      log.skip_reason = !all.length ? "empty_items" : "all_items_rejected";
      return { created: 0, proposals: 0, skipped: false, reason: log.skip_reason };
    }
    const hasNewItems = items.some((item) => item.kind === "new");
    const apply = database.db.transaction(() => {
      // Re-extraction removes only untouched rows created solely by this note.
      const old = database.db
        .prepare(
          "SELECT * FROM commitments WHERE source_note_id=? AND account_id IS ? AND source='meeting'"
        )
        .all(String(note.id), store.scope());
      for (const row of old) {
        if (!hasNewItems) continue;
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
    const result = apply();
    log.created_count = result.created;
    log.proposal_count = result.proposals;
    if (!result.created && !result.proposals) {
      log.skip_reason = !all.length
        ? "empty_items"
        : !items.length
          ? "all_items_rejected"
          : "no_new_todos";
      result.reason = log.skip_reason;
    }
    return result;
  } catch (error) {
    const messageStatus = String(error.message).match(/\b([45]\d{2})\b/);
    log.http_status =
      error.status ??
      error.statusCode ??
      error.response?.status ??
      (messageStatus ? Number(messageStatus[1]) : log.http_status);
    log.raw_response_length ||= error.rawLength ?? 0;
    if (error.message.startsWith("Malformed commitments") && typeof lastResponse === "string")
      log.raw_response_snippet = safeResponseSnippet(lastResponse);
    log.skip_reason = error.message.startsWith("Malformed commitments")
      ? "invalid_response"
      : log.http_status && log.http_status >= 400
        ? "http_error"
        : "extraction_failed";
    error.reason = log.skip_reason;
    throw error;
  } finally {
    writeExtractLog(log);
  }
}

async function extractForNote(noteId, { database, model, infer }) {
  if (!Number.isSafeInteger(noteId) || noteId <= 0) {
    writeExtractLog({
      note_id: noteId,
      ...transcriptInfo(null),
      segment_count: 0,
      model_id: model?.model ?? null,
      http_status: null,
      raw_response_length: 0,
      parsed_item_count: 0,
      accepted_count: 0,
      rejected_count: 0,
      rejected_reasons: {},
      created_count: 0,
      proposal_count: 0,
      skip_reason: "invalid_note_id",
    });
    return { created: 0, proposals: 0, skipped: true, reason: "invalid_note_id" };
  }
  const note = database.getNote(noteId);
  if (!note || note.deleted_at) {
    writeExtractLog({
      note_id: noteId,
      ...transcriptInfo(null),
      segment_count: 0,
      model_id: model?.model ?? null,
      http_status: null,
      raw_response_length: 0,
      parsed_item_count: 0,
      accepted_count: 0,
      rejected_count: 0,
      rejected_reasons: {},
      created_count: 0,
      proposal_count: 0,
      skip_reason: "note_missing",
    });
    return { created: 0, proposals: 0, skipped: true, reason: "note_missing" };
  }
  return extractCommitments({ note, database, model, infer });
}

function summaryActions(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const actions = [];
  let inActions = false;
  for (const line of lines) {
    const heading =
      line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/) || line.match(/^\s*\*\*(.+?)\*\*\s*:?\s*$/);
    if (heading) {
      inActions = /action items?|to-?dos?|next steps?/i.test(heading[1]);
      continue;
    }
    if (!inActions) continue;
    const bullet = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?(.+?)\s*$/);
    if (!bullet) continue;
    const split = bullet[1].match(/^(.*?)\s+[—–-]\s+(.+?)\s*$/);
    const action = (split ? split[1] : bullet[1]).trim();
    if (!action || !hasVerb(action)) continue;
    const owners =
      split?.[2]
        .split(/\s+(?:and|&)\s+|,/i)
        .map((name) => name.trim())
        .filter(Boolean) || [];
    actions.push({
      text: action,
      person: owners.length > 1 ? owners : owners[0] || null,
      quote: bullet[1],
    });
  }
  return actions;
}

function extractSummaryForNote(noteId, { database }) {
  const note = Number.isSafeInteger(noteId) && noteId > 0 ? database.getNote(noteId) : null;
  const log = {
    note_id: noteId,
    ...transcriptInfo(note?.transcript),
    segment_count: note ? parseSegments(note.transcript, note.id).length : 0,
    model_id: null,
    http_status: null,
    raw_response_length: 0,
    parsed_item_count: 0,
    accepted_count: 0,
    rejected_count: 0,
    rejected_reasons: {},
    created_count: 0,
    proposal_count: 0,
    skip_reason: null,
    source: "summary",
  };
  try {
    if (!note || note.deleted_at) {
      log.skip_reason = "note_missing";
      return { created: 0, proposals: 0, skipped: true, reason: log.skip_reason };
    }
    const actions = summaryActions(note.enhanced_content);
    log.parsed_item_count = actions.length;
    log.accepted_count = actions.length;
    if (!actions.length) {
      log.skip_reason = "no_summary_actions";
      return { created: 0, proposals: 0, skipped: true, reason: log.skip_reason };
    }
    const store = new CommitmentStore(database);
    log.created_count = database.db.transaction(() => {
      let created = 0;
      for (const action of actions) {
        const candidate = {
          text: normaliseText(action.text),
          person: action.person,
          direction: "owe",
        };
        if (store.list().some((row) => shouldMerge(row, candidate))) continue;
        store.create({
          ...candidate,
          source: "summary",
          source_note_id: note.id,
          source_note_title: note.title,
          space_id: note.space_id,
          quote: action.quote,
          quote_segment_index: null,
          extraction_version: VERSION,
        });
        created++;
      }
      return created;
    })();
    if (!log.created_count) log.skip_reason = "no_new_todos";
    return {
      created: log.created_count,
      proposals: 0,
      skipped: false,
      ...(log.skip_reason ? { reason: log.skip_reason } : {}),
    };
  } catch (error) {
    log.skip_reason = "extraction_failed";
    throw error;
  } finally {
    writeExtractLog(log);
  }
}

module.exports = {
  extractCommitments,
  extractForNote,
  extractSummaryForNote,
  summaryActions,
  parseSegments,
  windows,
  parseResponse,
  RESPONSE_FORMAT,
  MARKER,
};
