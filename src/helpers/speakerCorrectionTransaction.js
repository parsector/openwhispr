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
const { readTranscriptDocument, writeTranscriptDocument, normalizeRowIds } = require("./transcriptDocument");
const { readSpeakerActionLog, appendAction, removeNewestAction, newestAvailableAction, MAX_ACTION_LOG_BYTES } = require('./speakerActionLog');
const globalHistory = require('./speakerGlobalHistory');
const MAX_CORRECTION_BYTES = MAX_ACTION_LOG_BYTES;
const SPLIT_FIELDS = ["speaker", "speakerName", "speakerIsPlaceholder", "speakerStatus",
  "unknownNumber", "uncertainty", "speakerLocked", "speakerLockSource"];
const mappingKey = (runId, clusterId) => `run:${runId || "legacy"}:${clusterId}`;
const snapshot = (row) =>
  Object.fromEntries(FIELDS.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
const restore = (row, previous) => {
  const next = { ...row };
  for (const key of FIELDS) delete next[key];
  Object.assign(next, previous);
  return next;
};
const parse = (raw, noteId) => normalizeRowIds(readTranscriptDocument(raw).rows, noteId);
function applySpeakerCorrection(database, identifier, request) {
  const { noteId, id } = request;
  if (!noteId || !id || !["apply", "split", "undo"].includes(request.type))
    return { success: false, error: "invalid_request" };
  let committedMapping = null;
  let committedProfileId = null;
  const run = database.db.transaction(() => {
    const note = database.getNote(noteId);
    if (!note) return { success: false, error: "note_missing" };
    const log = readSpeakerActionLog(note);
    if (log.quarantined) return { success: false, error: 'history_quarantined' };
    const unavailable = request.type === 'undo' && globalHistory.status(database.db, id, noteId)?.unavailable_reason;
    if (unavailable) return { success: false, error: unavailable };
    if (request.type === 'undo' && !globalHistory.canUndo(database.db, id, noteId))
      return { success: false, error: 'later_change' };
    let nextLog = log;
    const saved = parse(note.transcript, note.client_note_id || noteId);
    const byId = new Map(saved.map((row) => [row.id, row]));
    // Live rows may not have reached the periodic save yet. They are included
    // once, while rows persisted during the IPC await remain in the note.
    for (const row of normalizeRowIds(request.rows || [], note.client_note_id || noteId))
      if (row?.id && !byId.has(row.id)) byId.set(row.id, row);
    let rows = [...byId.values()];
    let splitReport = null;
    if (request.type === "apply") {
      const { scope, target, name, profileId, email } = request;
      if (profileId != null && typeof database.db.prepare === 'function' &&
          !database.db.prepare('SELECT 1 FROM speaker_profiles WHERE id = ?').get(profileId))
        return { success: false, error: 'person_missing' };
      if (!["row", "selected", "cluster"].includes(scope))
        return { success: false, error: "invalid_request" };
      const ids = new Set(request.rowIds || []);
      const affected = rows.filter((row) => !row.deleted && (
        scope === "cluster"
          ? row.diarizationRunId === target?.runId && row.speaker === target?.clusterId
          : ids.has(row.id)
      ));
      if (!affected.length) return { success: false, error: "target_missing" };
      // Naming is the only step that links an attendee identity to transcript rows.
      // Register this note first so a speaker can reuse its attendee-only person.
      const canPersistIdentity = name && profileId == null && database.createNamedSpeakerProfile;
      if (canPersistIdentity && note.participants) require('./peopleActions').registerAttendees(database, noteId);
      const normalized = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
      const profiles = canPersistIdentity
        ? database.db.prepare('SELECT id, display_name, email FROM speaker_profiles ORDER BY id').all() : [];
      const existingProfile = profiles.find(p => email && normalized(p.email) === normalized(email))
        || profiles.find(p => normalized(p.display_name) === normalized(name));
      const createdProfile = canPersistIdentity && !existingProfile
        ? database.createNamedSpeakerProfile(name, email) : null;
      const chosenProfileId = profileId ?? existingProfile?.id ?? createdProfile?.id ?? null;
      committedProfileId = chosenProfileId;
      const key = scope === "cluster" ? mappingKey(target.runId, target.clusterId) : null;
      const before = key
        ? database.getSpeakerRunMapping(noteId, target.runId, target.clusterId)
        : null;
      // The empty string is the durable run-mapping sentinel for explicit Unknown.
      const after = key ? { display_name: name ?? "", profile_id: chosenProfileId } : null;
      const affectedRowIds = affected.map((row) => row.id);
      const affectedSet = new Set(affectedRowIds);
      const snapshots = {};
      const timestamp = new Date().toISOString();
      const sequence = log.nextSequence;
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
          correctionRevision: (Number(row.correctionRevision) || 0) + 1,
          suggestedName: undefined,
          suggestedProfileId: chosenProfileId ?? undefined,
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
        createdProfileId: createdProfile?.id,
      };
      const anchor = rows.find((row) => row.id === affected[0].id);
      anchor.corrections[anchor.corrections.length - 1] = event;
      nextLog = appendAction(log, { kind: 'correction', id, event });
      if (!nextLog)
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
    } else if (request.type === "split") {
      const { target, rowIds } = request;
      if (request.expectedTranscript != null && request.expectedTranscript !== note.transcript)
        return { success: false, error: "transcript_changed" };
      const cluster = rows.filter((row) => !row.deleted && row.diarizationRunId === target?.runId &&
        row.speaker === target?.clusterId);
      const reviewed = new Set(rowIds || []);
      const eligibleEvidence = (request.evidenceRowIds || []).filter((rowId) => {
        const row = cluster.find((candidate) => candidate.id === rowId);
        return row && !row.speakerLocked && row.speakerLockSource !== "user";
      });
      const selected = new Set([...(rowIds || []), ...eligibleEvidence]);
      if (cluster.length < 2 || !reviewed.size || selected.size >= cluster.length ||
        [...selected].some((rowId) => !cluster.some((row) => row.id === rowId)))
        return { success: false, error: "invalid_split" };
      const used = [
        ...rows.map((row) => row.speaker),
        ...(database.getSpeakerMappings?.(noteId) || []).map((mapping) => mapping.speaker_id),
      ].map((speaker) => /^speaker_(\d+)$/.exec(speaker || "")?.[1])
        .filter((number) => number != null).map(Number);
      const nextCluster = `speaker_${Math.max(-1, ...used) + 1}`;
      const snapshots = {};
      const changed = [];
      rows = rows.map((row) => {
        if (!selected.has(row.id)) return row;
        snapshots[row.id] = Object.fromEntries(SPLIT_FIELDS.filter((field) => row[field] !== undefined)
          .map((field) => [field, row[field]]));
        const next = { ...row, speaker: nextCluster, unknownNumber: undefined,
          correctionRevision: (Number(row.correctionRevision) || 0) + 1 };
        // A machine name inherited from the mixed cluster is no longer evidence
        // for the new one. Human locks and explicit Unknown remain authoritative.
        if (!row.speakerLocked && row.speakerLockSource !== "user") {
          next.speakerName = undefined;
          next.speakerIsPlaceholder = true;
          next.speakerStatus = "provisional";
          next.uncertainty = { reason: "possible_mixed_speakers" };
        }
        next.corrections = [...(row.corrections || []), { id, rowId: row.id,
          sequence: log.nextSequence }];
        changed.push(next);
        return next;
      });
      const event = { id, noteId, actor: "user", timestamp: new Date().toISOString(),
        sequence: log.nextSequence, target, rowIds: [...selected], reviewedRowIds: [...reviewed],
        newClusterId: nextCluster,
        snapshots };
      changed[0].corrections[changed[0].corrections.length - 1] = event;
      nextLog = appendAction(log, { kind: "split", id, event });
      if (!nextLog) return { success: false, error: "history_full" };
      splitReport = { movedRows: selected.size, retainedRows: cluster.length - selected.size,
        acousticRows: selected.size - reviewed.size, newClusterId: nextCluster,
        evidence: selected.size > reviewed.size ? "voice_embeddings" : "selected_rows" };
    } else {
      const action = newestAvailableAction(log);
      if (!log.actions.some((entry) => ['correction', 'split'].includes(entry.kind) && entry.id === id))
        return { success: false, error: 'correction_missing' };
      if (!action) return { success: false, error: log.actions.at(-1)?.unavailableReason || 'later_change' };
      if (!['correction', 'split'].includes(action.kind) || action.id !== id)
        return { success: false, error: 'later_change' };
      if (note.deleted_at) database.db.prepare("UPDATE notes SET deleted_at = NULL, sync_status = 'pending' WHERE id = ?").run(noteId);
      const event = action.event;
      nextLog = removeNewestAction(log);
      if (action.kind === 'split') {
        rows = rows.map((row) => {
          const previous = event.snapshots?.[row.id];
          if (!previous) return row;
          const next = { ...row };
          for (const field of SPLIT_FIELDS) delete next[field];
          Object.assign(next, previous);
          next.correctionRevision = (Number(row.correctionRevision) || 0) + 1;
          next.corrections = (row.corrections || []).filter((record) => record.id !== id);
          if (!next.corrections.length) delete next.corrections;
          return next;
        });
      } else {
      rows = rows.map((row) => {
        const record = (row.corrections || []).find((item) => item.id === id);
        if (!record) return row;
        const next = restore(row, event.snapshots?.[row.id]?.previous || record.previous || {});
        next.correctionRevision = (Number(row.correctionRevision) || 0) + 1;
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
    }
    const transcript = writeTranscriptDocument(rows, readTranscriptDocument(note.transcript).unknownNumberHighWater);
    const result = database.updateNote(noteId, { transcript,
      speaker_action_log: JSON.stringify(nextLog), speaker_label_undo: null });
    if (!result?.success) throw Error(result?.error || "transcript_failed");
    if (request.type === 'apply' || request.type === 'split') globalHistory.add(database.db, { id, kind: request.type,
      profileId: committedProfileId, noteId, label: request.type === 'split' ? 'Split cluster' : request.name || 'Unknown' });
    else globalHistory.remove(database.db, id, noteId);
    if (request.type === "undo" && newestAvailableAction(log)?.event?.createdProfileId)
      database.removeUnusedNamedSpeakerProfile?.(newestAvailableAction(log).event.createdProfileId);
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
    return { success: true, rows: readTranscriptDocument(transcript).rows,
      mapping: committedMapping, report: splitReport };
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
