const { randomUUID } = require("node:crypto");

const EDITABLE = new Set(["text", "person", "due_date", "due_raw", "status", "rejected_reason"]);
const STATUSES = new Set(["open", "proposed", "completed", "rejected"]);

function localToday(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function isOverdue(row, now = new Date()) {
  return row.status === "open" && row.direction !== "waiting" && row.due_date &&
    row.due_date < localToday(now) && (now.getHours() > 0 || now.getMinutes() >= 1);
}
function pinned(row) {
  try { return new Set(JSON.parse(row.pinned_fields || "[]")); }
  catch { return new Set(); }
}

class CommitmentStore {
  constructor(database) { this.database = database; this.db = database.db || database; }
  scope() { return this.database.activeAccountId || null; }
  get(id) { return this.db.prepare("SELECT * FROM commitments WHERE id=? AND account_id IS ?").get(id, this.scope()) || null; }
  remove(id) {
    return this.db.transaction(() => {
      if (!this.get(id)) return false;
      this.db.prepare("DELETE FROM commitment_mentions WHERE commitment_id=?").run(id);
      this.db.prepare("DELETE FROM commitment_proposals WHERE commitment_id=?").run(id);
      return this.db.prepare("DELETE FROM commitments WHERE id=? AND account_id IS ?")
        .run(id, this.scope()).changes === 1;
    })();
  }
  list(includeArchived = false) {
    return this.db.prepare(`SELECT commitments.*, (SELECT COUNT(*) FROM commitment_mentions m
      WHERE m.commitment_id=commitments.id AND m.kind='date_moved') AS date_move_count
      FROM commitments WHERE account_id IS ? AND archived_at IS ${includeArchived ? "NOT NULL" : "NULL"} ORDER BY created_at DESC`)
      .all(this.scope());
  }
  forNote(noteId) {
    return this.db.prepare(`SELECT * FROM commitments WHERE account_id IS ? AND source_note_id=?
      AND archived_at IS NULL AND quote_segment_index IS NOT NULL ORDER BY created_at DESC`)
      .all(this.scope(), String(noteId));
  }
  create(fields, { user = false, agent = null } = {}) {
    if (typeof fields?.text !== "string" || !fields.text.trim()) throw new Error("Todo text is required");
    if (fields.status && !STATUSES.has(fields.status)) throw new Error("Invalid status");
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(), account_id: this.scope(), space_id: fields.space_id || null,
      text: fields.text.trim(), quote: fields.quote || null,
      quote_segment_index: fields.quote_segment_index ?? null,
      source_note_id: fields.source_note_id == null ? null : String(fields.source_note_id),
      source_note_title: fields.source_note_title || null,
      source: agent ? "agent" : user ? "manual" : "meeting",
      source_agent: agent ? String(agent).slice(0, 100) : null,
      person: Array.isArray(fields.person) ? JSON.stringify(fields.person) : fields.person || null,
      direction: fields.direction === "waiting" ? "waiting" : "owe",
      due_date: fields.due_date || null, due_raw: fields.due_raw || null,
      due_confidence: fields.due_confidence ?? null, status: fields.status || "open",
      rejected_reason: fields.rejected_reason || null,
      speaker_confidence: fields.speaker_confidence || "unknown", mention_count: 1,
      pinned_fields: JSON.stringify(user ? Object.keys(fields).filter((key) => EDITABLE.has(key)) : []),
      extraction_version: fields.extraction_version || null, source_removed: 0,
      created_at: now, updated_at: now, completed_at: null, rejected_at: null, archived_at: null,
    };
    this.db.prepare(`INSERT INTO commitments (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    if (row.source_note_id) this.addMention(row.id, { kind: "created", note_id: row.source_note_id,
      segment_index: row.quote_segment_index, quote: row.quote });
    return this.get(row.id);
  }
  update(id, patch, { user = false } = {}) {
    const current = this.get(id);
    if (!current) return null;
    if (patch.status && !STATUSES.has(patch.status)) throw new Error("Invalid status");
    const existingPins = pinned(current);
    const values = {};
    for (const [key, value] of Object.entries(patch)) {
      if (!EDITABLE.has(key) || (!user && existingPins.has(key))) continue;
      values[key] = key === "person" && Array.isArray(value) ? JSON.stringify(value) : value;
      if (user) existingPins.add(key);
    }
    if (!Object.keys(values).length) return current;
    const now = new Date().toISOString();
    if (values.status === "completed") { values.completed_at = now; values.archived_at = now; }
    if (values.status === "rejected") { values.rejected_at = now; values.archived_at = now; }
    if (values.status === "open" || values.status === "proposed") {
      values.completed_at = null; values.rejected_at = null; values.archived_at = null;
    }
    if (user) values.pinned_fields = JSON.stringify([...existingPins]);
    values.updated_at = now;
    this.db.prepare(`UPDATE commitments SET ${Object.keys(values).map((key) => `${key}=?`).join(",")} WHERE id=?`)
      .run(...Object.values(values), id);
    return this.get(id);
  }
  setDue(id, dueDate, { user = true } = {}) {
    const before = this.get(id);
    if (!before) return null;
    const after = this.update(id, { due_date: dueDate, due_raw: null }, { user });
    if (before.due_date !== after.due_date) this.addMention(id, { kind: "date_moved",
      prev_value: before.due_date, new_value: after.due_date });
    return after;
  }
  addMention(commitmentId, fields) {
    this.db.prepare(`INSERT INTO commitment_mentions
      (id, commitment_id, note_id, segment_index, quote, kind, prev_value, new_value, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), commitmentId,
      fields.note_id == null ? null : String(fields.note_id), fields.segment_index ?? null,
      fields.quote || null, fields.kind, fields.prev_value || null, fields.new_value || null,
      new Date().toISOString());
  }
  restate(id, fields) {
    const row = this.get(id);
    if (!row || row.status !== "open") return row;
    this.db.prepare("UPDATE commitments SET mention_count=mention_count+1,updated_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
    this.addMention(id, { ...fields, kind: "restated" });
    return this.get(id);
  }
  propose(id, fields) {
    const row = this.get(id);
    if (!row || row.status !== "open" || pinned(row).has("status")) return null;
    const existing = this.db.prepare("SELECT * FROM commitment_proposals WHERE commitment_id=? AND note_id=? ORDER BY created_at DESC LIMIT 1")
      .get(id, String(fields.note_id));
    if (existing) return existing.status === "pending" ? existing : null;
    const created = new Date();
    const proposal = { id: randomUUID(), commitment_id: id, note_id: String(fields.note_id),
      segment_index: fields.segment_index, quote: fields.quote, strength: fields.strength,
      status: "pending", created_at: created.toISOString(),
      expires_at: new Date(created.getTime() + 7 * 86400000).toISOString() };
    this.db.prepare(`INSERT INTO commitment_proposals
      (id,commitment_id,note_id,segment_index,quote,strength,status,created_at,expires_at)
      VALUES (@id,@commitment_id,@note_id,@segment_index,@quote,@strength,@status,@created_at,@expires_at)`).run(proposal);
    this.update(id, { status: "proposed" });
    this.addMention(id, { ...fields, kind: "completion_proposed" });
    return proposal;
  }
  proposals(noteId = null) {
    const where = noteId == null ? "" : "AND p.note_id=?";
    return this.db.prepare(`SELECT p.*, c.text, c.person FROM commitment_proposals p JOIN commitments c ON c.id=p.commitment_id
      WHERE c.account_id IS ? AND p.status='pending' ${where} ORDER BY p.created_at DESC`)
      .all(...(noteId == null ? [this.scope()] : [this.scope(), String(noteId)]));
  }
  resolveProposal(id, accept) {
    const row = this.db.prepare(`SELECT p.* FROM commitment_proposals p JOIN commitments c ON c.id=p.commitment_id
      WHERE p.id=? AND c.account_id IS ? AND p.status='pending'`).get(id, this.scope());
    if (!row) return null;
    this.db.prepare("UPDATE commitment_proposals SET status=?,resolved_at=? WHERE id=?")
      .run(accept ? "accepted" : "rejected", new Date().toISOString(), id);
    this.update(row.commitment_id, { status: accept ? "completed" : "open" }, { user: accept });
    return this.get(row.commitment_id);
  }
  overdueCount(now = new Date()) { return this.list().filter((row) => isOverdue(row, now)).length; }
  mentions(id) { return this.db.prepare("SELECT * FROM commitment_mentions WHERE commitment_id=? ORDER BY created_at").all(id); }
  sweepExpired(now = new Date()) {
    return this.db.transaction(() => {
      const expired = this.db.prepare(`SELECT p.* FROM commitment_proposals p JOIN commitments c ON c.id=p.commitment_id
        WHERE c.account_id IS ? AND p.status='pending' AND p.expires_at<=?`)
        .all(this.scope(), now.toISOString());
      for (const proposal of expired) {
        this.db.prepare("UPDATE commitment_proposals SET status='expired',resolved_at=? WHERE id=?")
          .run(now.toISOString(), proposal.id);
        const remaining = this.db.prepare("SELECT 1 FROM commitment_proposals WHERE commitment_id=? AND status='pending' LIMIT 1")
          .get(proposal.commitment_id);
        if (!remaining && this.get(proposal.commitment_id)?.status === "proposed")
          this.update(proposal.commitment_id, { status: "open" });
      }
      return expired.length;
    })();
  }
  sourceRemoved(noteId) {
    const id = String(noteId);
    return this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE commitments SET quote=NULL,quote_segment_index=NULL,
        source_removed=1,updated_at=? WHERE source_note_id=? AND account_id IS ?`)
        .run(new Date().toISOString(), id, this.scope()).changes;
      this.db.prepare("UPDATE commitment_mentions SET quote=NULL WHERE note_id=? AND commitment_id IN (SELECT id FROM commitments WHERE account_id IS ?)")
        .run(id, this.scope());
      this.db.prepare("UPDATE commitment_proposals SET quote=NULL WHERE note_id=? AND commitment_id IN (SELECT id FROM commitments WHERE account_id IS ?)")
        .run(id, this.scope());
      return changed;
    })();
  }
  sweepRemovedSources() {
    const ids = this.db.prepare(`SELECT DISTINCT c.source_note_id AS id FROM commitments c
      LEFT JOIN notes n ON CAST(n.id AS TEXT)=c.source_note_id
      WHERE c.account_id IS ? AND c.source_note_id IS NOT NULL AND c.source_removed=0
        AND (n.id IS NULL OR n.deleted_at IS NOT NULL)`).all(this.scope());
    return ids.reduce((total, row) => total + this.sourceRemoved(row.id), 0);
  }
}

module.exports = { CommitmentStore, isOverdue, localToday };
