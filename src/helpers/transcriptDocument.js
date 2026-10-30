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
  return rows.map((row) => {
    if (row.id) return row;
    const key = rowIdentityKey(row);
    const occurrence = seen.get(key) || 0;
    seen.set(key, occurrence + 1);
    return { ...row, id: legacyUuid(noteId, `${key}\0${occurrence}`) };
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
  const rows = doc.rows.map((row) => {
    const unique = row.id && counts.get(row.id) === 1 ? row.id : null;
    const id = unique ? (UUID_RE.test(unique) ? unique : legacyUuid(noteId, unique)) : globalThis.crypto.randomUUID();
    if (unique) ids.set(unique, id);
    if (id !== row.id) migrated = true;
    return { ...row, id };
  });
  let quarantinedCorrections = 0;
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
  const numbers = new Map();
  let next = Math.max(noteHighWater, 0, ...rows.map((row) =>
    Math.max(row.unknownNumber || 0, row.unknownNumberHighWater || 0))) + 1;
  for (const [index, row] of rows.entries()) {
    if (row.unknownNumber) numbers.set(row.speaker
      ? `${row.diarizationRunId || "legacy"}:${row.speaker}`
      : row.id ?? `${row.source || "unknown"}:${row.timestamp ?? index}`, row.unknownNumber);
  }
  const assigned = rows.map((row, index) => {
    if (!(typeof row.speaker === "string" && row.speaker) &&
        !(typeof row.speakerName === "string" && row.speakerName) &&
        row.source !== "mic" && row.source !== "system" && !row.speakerLocked) return { ...row };
    const key = row.speaker
      ? `${row.diarizationRunId || "legacy"}:${row.speaker}`
      : row.id ?? `${row.source || "unknown"}:${row.timestamp ?? index}`;
    if (!numbers.has(key)) numbers.set(key, next++);
    return { ...row, unknownNumber: row.unknownNumber ?? numbers.get(key) };
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
    "unknownNumber", "diarizationRunId"];
  const numbered = allocateUnknownNumbers(normalizeRowIds(rows), unknownNumberHighWater);
  const visible = numbered.map((row) => Object.fromEntries(
    fields.filter((field) => row[field] !== undefined &&
      !(field === "speakerName" && row.speakerIsPlaceholder))
      .map((field) => [field, row[field]])
  ));
  return JSON.stringify({ version: 2, unknownNumberHighWater: Math.max(unknownNumberHighWater,
    ...numbered.map((row) => row.unknownNumber || 0), 0), rows: visible });
}

function mergeLocalTranscriptState(cloudRaw, localRaw) {
  if (!isTranscriptDocument(cloudRaw) || !isTranscriptDocument(localRaw)) return cloudRaw;
  const cloud = readTranscriptDocument(cloudRaw);
  const local = readTranscriptDocument(localRaw);
  const localRows = normalizeRowIds(local.rows);
  const cloudRows = normalizeRowIds(cloud.rows);
  const localById = new Map(localRows.map((row) => [row.id, row]));
  const localByKey = new Map();
  for (const row of localRows) {
    const key = rowIdentityKey(row);
    if (!localByKey.has(key)) localByKey.set(key, []);
    localByKey.get(key).push(row);
  }
  const used = new Set();
  const conflicts = [];
  const rows = cloudRows.map((incoming) => {
    const direct = localById.get(incoming.id);
    const own = (direct && !used.has(direct.id) ? direct : null) ||
      localByKey.get(rowIdentityKey(incoming))?.find((row) => !used.has(row.id));
    if (!own) return incoming;
    used.add(own.id);
    const row = { ...incoming, id: own.id };
    const sameLabel = own.speakerName === row.speakerName &&
      !!own.speakerIsPlaceholder === !!row.speakerIsPlaceholder &&
      !!own.speakerLocked === !!row.speakerLocked;
    const ownUser = own.speakerLockSource === "user";
    const cloudUser = row.speakerLockSource === "user";
    if (ownUser && !sameLabel && cloudUser) {
      conflicts.push({ ...own, id: globalThis.crypto.randomUUID(), conflictOf: own.id });
    }
    const authoritative = ownUser && !cloudUser ? own : row;
    return { ...authoritative,
      id: own.id,
      corrections: own.corrections,
      quarantinedCorrections: own.quarantinedCorrections,
      ...(sameLabel ? { suggestedName: own.suggestedName,
        suggestedProfileId: own.suggestedProfileId, uncertainty: own.uncertainty } : {}),
    };
  });
  rows.push(...localRows.filter((row) => !used.has(row.id)), ...conflicts);
  return writeTranscriptDocument(rows, Math.max(cloud.unknownNumberHighWater,
    local.unknownNumberHighWater));
}

function reconcileAutomaticTranscript(proposedRaw, currentRaw) {
  const proposed = readTranscriptDocument(proposedRaw);
  const current = readTranscriptDocument(currentRaw);
  const byId = new Map(current.rows.filter((row) => row.id).map((row) => [row.id, row]));
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
    row.speakerLockSource === "user"));
  return writeTranscriptDocument(rows, Math.max(proposed.unknownNumberHighWater,
    current.unknownNumberHighWater));
}

export { readTranscriptDocument, writeTranscriptDocument, publicTranscript, isTranscriptDocument,
  allocateUnknownNumbers, mergeLocalTranscriptState, reconcileAutomaticTranscript,
  normalizeRowIds, migrateTranscriptDocument };
