// The note owns the counter even when its last row is removed. Old notes are
// arrays; version 2 stores note metadata beside the rows.
function readTranscriptDocument(raw) {
  let parsed;
  try { parsed = JSON.parse(raw || "[]"); } catch { parsed = []; }
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rows) ? parsed.rows : [];
  const highWater = Math.max(0, Number(Array.isArray(parsed) ? 0 : parsed.unknownNumberHighWater) || 0,
    ...rows.map((row) => Math.max(Number(row.unknownNumber) || 0, Number(row.unknownNumberHighWater) || 0)));
  return { rows, unknownNumberHighWater: highWater };
}

function isTranscriptDocument(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) || Array.isArray(parsed?.rows);
  } catch { return false; }
}

function rowIdentityKey(row) {
  return [row.source || "", row.timestamp ?? "", String(row.text || "").trim().replace(/\s+/g, " ")].join("|");
}

function normalizeRowIds(rows, noteId = "unknown") {
  const seen = new Map();
  const counts = new Map();
  for (const row of rows) if (row.id) counts.set(row.id, (counts.get(row.id) || 0) + 1);
  const used = new Set(rows.map((row) => row.id).filter(Boolean));
  const kept = new Set();
  return rows.map((row) => {
    const safeRow = row.id && counts.get(row.id) > 1 && row.corrections?.length
      ? { ...row, quarantinedCorrections: [...(row.quarantinedCorrections || []), ...row.corrections],
        corrections: undefined }
      : row;
    if (row.id && !kept.has(row.id)) {
      kept.add(row.id);
      return safeRow;
    }
    const key = rowIdentityKey(row);
    let occurrence = seen.get(key) || 0;
    let id;
    do { id = legacyUuid(noteId, `${key}\0${occurrence++}`); } while (used.has(id));
    seen.set(key, occurrence);
    used.add(id);
    return { ...safeRow, id,
      ...(row.id ? { idRepair: { previousId: row.id, reason: "duplicate_id" } } : {}) };
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function legacyUuid(noteId, oldId) {
  const input = `${noteId ?? "unknown"}\0${oldId}`;
  const hash = (seed) => {
    let value = seed;
    for (let i = 0; i < input.length; i++) value = Math.imul(value ^ input.charCodeAt(i), 16777619);
    return (value >>> 0).toString(16).padStart(8, "0");
  };
  const hex = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35].map(hash).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function migrateTranscriptDocument(raw, noteId) {
  const doc = readTranscriptDocument(raw);
  const counts = new Map();
  for (const row of doc.rows) if (row.id) counts.set(row.id, (counts.get(row.id) || 0) + 1);
  const ids = new Map();
  let migrated = false;
  const rows = normalizeRowIds(doc.rows.map((row) => {
    const unique = row.id && counts.get(row.id) === 1 ? row.id : null;
    const id = row.id && !UUID_RE.test(row.id) ? legacyUuid(noteId, row.id) : row.id;
    if (unique) ids.set(unique, id);
    if (id !== row.id) migrated = true;
    return { ...row, id };
  }), noteId);
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].idRepair && !doc.rows[index].idRepair)
      rows[index].idRepair.previousId = doc.rows[index].id;
  }
  if (rows.some((row, index) => row.id !== doc.rows[index].id)) migrated = true;
  let quarantinedCorrections = rows.reduce((count, row, index) => count +
    Math.max(0, (row.quarantinedCorrections?.length || 0) -
      (doc.rows[index].quarantinedCorrections?.length || 0)), 0);
  for (const row of rows) {
    if (!row.corrections?.length) continue;
    const retained = [];
    const quarantined = [...(row.quarantinedCorrections || [])];
    for (const record of row.corrections) {
      const rowId = ids.get(record.rowId);
      const affected = record.affectedRowIds?.map((id) => ids.get(id));
      const targetIds = record.target?.rowIds?.map((id) => ids.get(id));
      const snapshotIds = record.snapshots && Object.keys(record.snapshots).map((id) => ids.get(id));
      if (rowId !== row.id || affected?.some((id) => !id) ||
          targetIds?.some((id) => !id) || snapshotIds?.some((id) => !id)) {
        quarantined.push(record);
        quarantinedCorrections++;
        migrated = true;
        continue;
      }
      retained.push({ ...record, rowId,
        noteId: record.noteId ?? noteId,
        ...(affected ? { affectedRowIds: affected } : {}),
        ...(targetIds ? { target: { ...record.target, rowIds: targetIds } } : {}),
        ...(record.snapshots ? { snapshots: Object.fromEntries(Object.entries(record.snapshots)
          .map(([id, value]) => [ids.get(id), value])) } : {}),
      });
    }
    row.corrections = retained;
    if (quarantined.length) row.quarantinedCorrections = quarantined;
  }
  return { rows, unknownNumberHighWater: doc.unknownNumberHighWater,
    migrated, quarantinedCorrections };
}

// The only number allocator. Call it with the complete note and the note's
// persisted high-water mark before displaying or saving rows.
function allocateUnknownNumbers(rows, noteHighWater = 0) {
  const groups = new Map();
  const keyFor = (row, index) => row.speaker
    ? `cluster:${row.diarizationRunId || "legacy"}:${row.speaker}`
    : `row:${row.id ?? `${row.source || "unknown"}:${row.timestamp ?? index}`}`;
  for (const [index, row] of rows.entries()) {
    if (row.deleted) continue;
    const key = keyFor(row, index);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  let next = Math.max(noteHighWater, 0, ...rows.map((row) =>
    Math.max(Number(row.unknownNumber) || 0, Number(row.unknownNumberHighWater) || 0))) + 1;
  const numbers = new Map();
  const owned = new Set();
  for (const [key, members] of groups) {
    const counts = new Map();
    for (const row of members) if (Number(row.unknownNumber) > 0)
      counts.set(row.unknownNumber, (counts.get(row.unknownNumber) || 0) + 1);
    const preferred = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (preferred && !owned.has(preferred)) {
      numbers.set(key, preferred);
      owned.add(preferred);
    }
  }
  const assigned = rows.map((row, index) => {
    if (row.deleted) return { ...row };
    if (!(typeof row.speaker === "string" && row.speaker) &&
        !(typeof row.speakerName === "string" && row.speakerName) &&
        row.source !== "mic" && row.source !== "system" && !row.speakerLocked) return { ...row };
    const key = keyFor(row, index);
    if (!numbers.has(key)) {
      while (owned.has(next)) next++;
      numbers.set(key, next);
      owned.add(next++);
    }
    return { ...row, unknownNumber: numbers.get(key) };
  });
  const highWater = Math.max(noteHighWater, next - 1,
    ...assigned.map((row) => row.unknownNumber || 0));
  return assigned.map((row) => ({ ...row, unknownNumberHighWater: highWater }));
}

function writeTranscriptDocument(rows, highWater = 0) {
  const numbered = allocateUnknownNumbers(rows, highWater);
  return JSON.stringify({ version: 2, unknownNumberHighWater: Math.max(highWater,
    ...numbered.map((row) => Math.max(Number(row.unknownNumber) || 0, Number(row.unknownNumberHighWater) || 0)), 0), rows: numbered });
}

// Explicit allowlist: new local evidence fields cannot cross this boundary.
function publicTranscript(raw) {
  if (!raw || !isTranscriptDocument(raw)) return raw;
  const { rows, unknownNumberHighWater } = readTranscriptDocument(raw);
  const fields = ["id", "text", "source", "timestamp", "speaker", "speakerName",
    "speakerIsPlaceholder", "speakerLocked", "speakerLockSource", "speakerStatus",
    "unknownNumber", "diarizationRunId", "deleted"];
  fields.push("speakerAssessmentAvailable");
  const numbered = allocateUnknownNumbers(normalizeRowIds(rows), unknownNumberHighWater);
  const visible = numbered.map((row) => row.deleted ? { id: row.id, deleted: true } : Object.fromEntries(
    fields.filter((field) => row[field] !== undefined &&
      !(field === "speakerName" && row.speakerIsPlaceholder))
      .map((field) => [field, row[field]])
  ));
  return JSON.stringify({ version: 2, unknownNumberHighWater: Math.max(unknownNumberHighWater,
    ...numbered.map((row) => row.unknownNumber || 0), 0), rows: visible });
}

function reconcileCloudTranscript(cloudRaw, localRaw, { syncedBefore = false, noteId = "unknown", takeTheirs = false, keepMine = false } = {}) {
  if (!isTranscriptDocument(cloudRaw))
    return { transcript: cloudRaw, conflicted: false, pendingUpload: false };
  const cloud = readTranscriptDocument(cloudRaw);
  const cloudIds = normalizeRowIds(cloud.rows, noteId);
  const local = isTranscriptDocument(localRaw) ? readTranscriptDocument(localRaw)
    : { rows: [], unknownNumberHighWater: 0 };
  const localRows = normalizeRowIds(local.rows);
  const localById = new Map(localRows.map((row) => [row.id, row]));
  const used = new Set();
  let conflicted = false;
  let pendingUpload = false;
  const rows = cloud.rows.map((raw, index) => {
    const idlessCandidates = raw.id ? [] : localRows.filter((candidate) =>
      !used.has(candidate.id) && rowIdentityKey(candidate) === rowIdentityKey(raw));
    const own = raw.id ? localById.get(raw.id) : idlessCandidates.length === 1 ? idlessCandidates[0] : null;
    const id = raw.id || own?.id || cloudIds[index].id;
    const incoming = { ...raw, id };
    for (const field of ["corrections", "quarantinedCorrections", "suggestedName",
      "suggestedProfileId", "uncertainty", "idRepair"]) delete incoming[field];
    if (!own) return incoming;
    used.add(own.id);
    const ownUser = own.speakerLockSource === "user" || own.deleted;
    const changed = own.speakerName !== incoming.speakerName ||
      !!own.speakerIsPlaceholder !== !!incoming.speakerIsPlaceholder ||
      !!own.speakerLocked !== !!incoming.speakerLocked ||
      !!own.deleted !== !!incoming.deleted;
    if (ownUser && changed && !takeTheirs && !keepMine) conflicted = true;
    if (ownUser && changed && keepMine) {
      pendingUpload = true;
      if (incoming.deleted && !own.deleted) return { ...own };
      for (const field of ["speakerName", "speakerIsPlaceholder", "speakerLocked",
        "speakerLockSource", "speakerStatus", "deleted"]) {
        if (own[field] === undefined) delete incoming[field];
        else incoming[field] = own[field];
      }
    }
    return { ...incoming, corrections: own.corrections,
      quarantinedCorrections: own.quarantinedCorrections,
      correctionRevision: own.correctionRevision,
      idRepair: own.idRepair,
      suggestedName: own.suggestedName, suggestedProfileId: own.suggestedProfileId,
      uncertainty: own.uncertainty,
      ...(takeTheirs && changed ? { corrections: undefined, quarantinedCorrections: undefined,
        suggestedName: undefined, suggestedProfileId: undefined, uncertainty: undefined } : {}) };
  });
  for (const own of localRows) if (!used.has(own.id)) {
    if (syncedBefore && own.syncState !== "local") {
      if (own.speakerLockSource === "user" && !own.deleted && !takeTheirs && !keepMine) conflicted = true;
      const preserve = keepMine && own.speakerLockSource === "user" && !own.deleted;
      if (preserve) pendingUpload = true;
      rows.push(preserve ? own : { id: own.id, deleted: true });
    } else {
      rows.push(own);
      pendingUpload = true;
    }
  }
  return { transcript: conflicted ? localRaw : writeTranscriptDocument(rows,
    Math.max(cloud.unknownNumberHighWater, local.unknownNumberHighWater)),
    conflicted, pendingUpload };
}

function mergeLocalTranscriptState(cloudRaw, localRaw) {
  return reconcileCloudTranscript(cloudRaw, localRaw).transcript;
}

function reconcileAutomaticTranscript(proposedRaw, currentRaw) {
  const proposed = readTranscriptDocument(proposedRaw);
  const current = readTranscriptDocument(currentRaw);
  const byId = new Map(current.rows.filter((row) => row.id).map((row) => [row.id, row]));
  for (const row of proposed.rows) {
    const own = byId.get(row.id);
    if (own?.deleted && !row.deleted) return null;
    if (own && (Number(row.correctionRevision) || 0) !==
        (Number(own.correctionRevision) || 0)) return null;
  }
  const seen = new Set();
  const rows = proposed.rows.map((row) => {
    const own = byId.get(row.id);
    if (!own) return row;
    seen.add(row.id);
    const protectedAssignment = own.speakerLockSource === "user";
    return protectedAssignment ? {
      ...row,
      speakerName: own.speakerName,
      speakerIsPlaceholder: own.speakerIsPlaceholder,
      speakerStatus: own.speakerStatus,
      speakerLocked: own.speakerLocked,
      speakerLockSource: own.speakerLockSource,
      corrections: own.corrections,
      quarantinedCorrections: own.quarantinedCorrections,
      suggestedName: own.suggestedName,
      suggestedProfileId: own.suggestedProfileId,
    } : row;
  });
  rows.push(...current.rows.filter((row) => !seen.has(row.id) &&
    (row.speakerLockSource === "user" || row.deleted)));
  return writeTranscriptDocument(rows, Math.max(proposed.unknownNumberHighWater,
    current.unknownNumberHighWater));
}

export { readTranscriptDocument, writeTranscriptDocument, publicTranscript, isTranscriptDocument,
  allocateUnknownNumbers, mergeLocalTranscriptState, reconcileAutomaticTranscript,
  reconcileCloudTranscript, normalizeRowIds, migrateTranscriptDocument };
