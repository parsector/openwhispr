// A correction changes a note transcript and its run-scoped mapping in one
// SQLite transaction. The in-memory identifier is changed only after commit.
const FIELDS = [
  "speakerName",
  "speakerIsPlaceholder",
  "speakerStatus",
  "speakerLocked",
  "speakerLockSource",
  "suggestedName",
  "suggestedProfileId",
  "uncertainty",
];
const { readTranscriptDocument, writeTranscriptDocument } = require("./transcriptDocument");
const MAX_CORRECTION_BYTES = 16 * 1024 * 1024;
const mappingKey = (runId, clusterId) => `run:${runId || "legacy"}:${clusterId}`;
const snapshot = (row) =>
  Object.fromEntries(FIELDS.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
const restore = (row, previous) => {
  const next = { ...row };
  for (const key of FIELDS) delete next[key];
  Object.assign(next, previous);
  return next;
};
const parse = (raw) => readTranscriptDocument(raw).rows;
function applySpeakerCorrection(database, identifier, request) {
  const { noteId, id } = request;
  if (!noteId || !id || !["apply", "undo"].includes(request.type))
    return { success: false, error: "invalid_request" };
  let committedMapping = null;
  const run = database.db.transaction(() => {
    const note = database.getNote(noteId);
    if (!note) return { success: false, error: "note_missing" };
    const saved = parse(note.transcript);
    const byId = new Map(saved.map((row) => [row.id, row]));
    // Live rows may not have reached the periodic save yet. They are included
    // once, while rows persisted during the IPC await remain in the note.
    for (const row of request.rows || []) if (row?.id && !byId.has(row.id)) byId.set(row.id, row);
    let rows = [...byId.values()];
    if (request.type === "apply") {
      const { scope, target, name, profileId } = request;
      if (!["row", "selected", "cluster"].includes(scope))
        return { success: false, error: "invalid_request" };
      const ids = new Set(request.rowIds || []);
      const affected = rows.filter((row) =>
        scope === "cluster"
          ? row.diarizationRunId === target?.runId && row.speaker === target?.clusterId
          : ids.has(row.id)
      );
      if (!affected.length) return { success: false, error: "target_missing" };
      const key = scope === "cluster" ? mappingKey(target.runId, target.clusterId) : null;
      const before = key
        ? database.getSpeakerRunMapping(noteId, target.runId, target.clusterId)
        : null;
      const after = key ? { display_name: name, profile_id: profileId ?? null } : null;
      const affectedRowIds = affected.map((row) => row.id);
      const affectedSet = new Set(affectedRowIds);
      const snapshots = {};
      const timestamp = new Date().toISOString();
      const sequence =
        Math.max(
          0,
          ...rows.flatMap((row) => row.corrections || []).map((record) => record.sequence || 0)
        ) + 1;
      rows = rows.map((row) => {
        if (!affectedSet.has(row.id)) return row;
        const previous = snapshot(row);
        const next = {
          ...row,
          speakerName: name || undefined,
          speakerIsPlaceholder: !name,
          speakerStatus: "locked",
          speakerLocked: true,
          speakerLockSource: "user",
          suggestedName: undefined,
          suggestedProfileId: profileId ?? undefined,
          uncertainty: undefined,
        };
        snapshots[row.id] = { previous, next: snapshot(next) };
        const record = {
          id,
          rowId: row.id,
          sequence,
        };
        return { ...next, corrections: [...(row.corrections || []), record] };
      });
      const event = {
        id, noteId, rowId: affected[0].id, scope, actor: "user", timestamp, sequence,
        diarizationRunId: affected[0].diarizationRunId,
        clusterId: scope === "cluster" ? target.clusterId : undefined,
        target: scope === "cluster" ? target : { rowIds: affectedRowIds },
        affectedRowIds, snapshots, mappingChanged: !!key,
        mappingBefore: before && { displayName: before.display_name, profileId: before.profile_id },
        mappingAfter: after && { displayName: after.display_name, profileId: after.profile_id },
      };
      const anchor = rows.find((row) => row.id === affected[0].id);
      anchor.corrections[anchor.corrections.length - 1] = event;
      // Keep every accepted event undoable. Reject a new one when this note's
      // local history reaches its size budget; never discard older events.
      if (Buffer.byteLength(JSON.stringify(rows.map((row) => row.corrections || [])), "utf8") > MAX_CORRECTION_BYTES)
        return { success: false, error: "history_full", recoverableBy: "undo_correction" };
      if (key) {
        const result = database.setSpeakerRunMapping(
          noteId,
          target.runId,
          target.clusterId,
          after.profile_id,
          after.display_name
        );
        if (!result?.success) throw Error(result?.error || "mapping_failed");
        committedMapping = { runId: target.runId, clusterId: target.clusterId, value: after };
      }
    } else {
      const records = rows
        .flatMap((row) => row.corrections || [])
        .filter((record) => record.id === id);
      if (!records.length) return { success: false, error: "correction_missing" };
      const event = records.find((record) => record.snapshots) || records[0];
      const affected = new Set(event.affectedRowIds || records.map((record) => record.rowId));
      const sameTarget = (record) =>
        event.scope === "cluster" &&
        (record.scope === "cluster" || !!record.snapshots) &&
        record.clusterId === event.clusterId &&
        record.diarizationRunId === event.diarizationRunId;
      const laterOnTarget = rows.some((row) =>
        (row.corrections || []).some(
          (record) =>
            record.id !== id &&
            sameTarget(record) &&
            (record.sequence != null && event.sequence != null
              ? record.sequence > event.sequence
              : record.timestamp >= event.timestamp)
        )
      );
      const laterOnRow = rows.some(
        (row) =>
          affected.has(row.id) &&
          (row.corrections || []).some(
            (record, index, list) => record.id === id && index < list.length - 1
          )
      );
      const changedElsewhere = rows.some((row) => {
        const record = (row.corrections || []).find((item) => item.id === id);
        const next = event.snapshots?.[row.id]?.next || record?.next;
        return record && (row.speakerName !== next?.speakerName ||
          !!row.speakerIsPlaceholder !== !!next?.speakerIsPlaceholder ||
          !!row.speakerLocked !== !!next?.speakerLocked);
      });
      if (laterOnTarget || laterOnRow || changedElsewhere)
        return { success: false, error: "later_change" };
      rows = rows.map((row) => {
        const record = (row.corrections || []).find((item) => item.id === id);
        if (!record) return row;
        const next = restore(row, event.snapshots?.[row.id]?.previous || record.previous || {});
        const remaining = (row.corrections || []).filter((item) => item.id !== id);
        if (remaining.length) next.corrections = remaining;
        else delete next.corrections;
        return next;
      });
      if (event.mappingChanged && event.clusterId) {
        const before = event.mappingBefore;
        const result = before
          ? database.setSpeakerRunMapping(
              noteId,
              event.diarizationRunId,
              event.clusterId,
              before.profileId ?? null,
              before.displayName
            )
          : database.removeSpeakerRunMapping(noteId, event.diarizationRunId, event.clusterId);
        if (!result?.success) throw Error(result?.error || "mapping_failed");
        committedMapping = { runId: event.diarizationRunId, clusterId: event.clusterId,
          value: before || null };
      }
    }
    const transcript = writeTranscriptDocument(rows, readTranscriptDocument(note.transcript).unknownNumberHighWater);
    const result = database.updateNote(noteId, { transcript });
    if (!result?.success) throw Error(result?.error || "transcript_failed");
    if (committedMapping && identifier &&
      (identifier.activeRunId === undefined || identifier.activeRunId === committedMapping.runId)) {
      const { clusterId, value } = committedMapping;
      if (value?.display_name || value?.displayName)
        identifier.mapSpeaker(
          clusterId,
          value.profile_id ?? value.profileId ?? null,
          value.display_name ?? value.displayName,
          noteId
        );
      else identifier.unmapSpeaker?.(clusterId, noteId);
    }
    return { success: true, rows, mapping: committedMapping };
  });
  const caches =
    identifier &&
    ["transientDisplayNames", "transientProfileIds", "transientNoteIds"].map((key) => [
      key,
      identifier[key] && new Map(identifier[key]),
    ]);
  try {
    return run();
  } catch (error) {
    for (const [key, snapshot] of caches || []) {
      if (snapshot) identifier[key] = snapshot;
    }
    throw error;
  }
}
module.exports = { applySpeakerCorrection, mappingKey, MAX_CORRECTION_BYTES };
