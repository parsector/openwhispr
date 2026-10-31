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
  const priorityGroups = [...groups].sort((left, right) =>
    Number(right[1].some(row => row.speakerLocked && row.speakerIsPlaceholder)) -
    Number(left[1].some(row => row.speakerLocked && row.speakerIsPlaceholder)));
  for (const [key, members] of priorityGroups) {
    const counts = new Map();
    const locked = members.filter(row => row.speakerLocked && row.speakerIsPlaceholder);
    for (const row of locked.length ? locked : members) if (Number(row.unknownNumber) > 0)
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
function publicTranscript(raw, speakerMappings = {}) {
  if (!raw || !isTranscriptDocument(raw)) return raw;
  const { rows, unknownNumberHighWater } = readTranscriptDocument(raw);
  const fields = ["id", "text", "source", "timestamp", "speakerName",
    "speakerIsPlaceholder", "unknownNumber", "deleted"];
  const numbered = allocateUnknownNumbers(normalizeRowIds(rows), unknownNumberHighWater);
  const originalIdCounts = new Map();
  for (const row of rows) if (typeof row.id === "string" && row.id.trim())
    originalIdCounts.set(row.id, (originalIdCounts.get(row.id) || 0) + 1);
  const visible = numbered.filter((row, index) => !row.deleted ||
    (typeof rows[index].id === "string" && !!rows[index].id.trim() &&
      originalIdCounts.get(rows[index].id) === 1))
    .map((row) => {
      if (row.deleted) return { id: row.id, deleted: true };
      const fixedAssignment = row.speakerLocked || row.speakerLockSource === "user" ||
        row.diarizationRunId;
      const mappedName = !fixedAssignment && row.speaker
        ? speakerMappings[row.speaker] : undefined;
      const displayedName = fixedAssignment
        ? (row.speakerIsPlaceholder ? undefined : row.speakerName)
        : mappedName || (row.speakerIsPlaceholder ? undefined : row.speakerName ||
          (typeof row.speaker === "string" && row.speaker !== "you" &&
          !row.speaker.startsWith("speaker_") ? row.speaker : undefined));
      return Object.fromEntries(fields.filter((field) => {
        if (field === "speakerName") return displayedName !== undefined;
        if (field === "speakerIsPlaceholder") return !!row.speakerIsPlaceholder && !displayedName;
        return row[field] !== undefined;
      }).map((field) => [field, field === "speakerName" ? displayedName : row[field]]));
    });
  return JSON.stringify({ version: 2, rows: visible });
}

// Cloud rows are display data. An existing note's attribution, evidence and
// history are owned by this device. Identity is only the durable row id.
function reconcileCloudTranscript(cloudRaw, localRaw, { noteId = "unknown" } = {}) {
  if (!isTranscriptDocument(cloudRaw))
    return { transcript: localRaw || cloudRaw, pendingUpload: false, quarantinedMarkers: [] };
  const cloud = readTranscriptDocument(cloudRaw);
  const local = isTranscriptDocument(localRaw) ? readTranscriptDocument(localRaw)
    : { rows: [], unknownNumberHighWater: 0 };
  const localRows = normalizeRowIds(local.rows, noteId);
  const rows = [...localRows];
  const byId = new Map(rows.map((row, index) => [row.id, index]));
  const cloudCounts = new Map();
  const liveCounts = new Map();
  for (const row of cloud.rows) {
    if (!row.id) continue;
    cloudCounts.set(row.id, (cloudCounts.get(row.id) || 0) + 1);
    if (!row.deleted) liveCounts.set(row.id, (liveCounts.get(row.id) || 0) + 1);
  }
  const repaired = normalizeRowIds(cloud.rows, noteId);
  const quarantinedMarkers = [];
  for (const [index, raw] of cloud.rows.entries()) {
    if (raw.deleted) {
      if (typeof raw.id !== "string" || !raw.id.trim() || cloudCounts.get(raw.id) !== 1) {
        quarantinedMarkers.push({ marker: { id: typeof raw.id === "string" ? raw.id : null,
          deleted: true }, reason: "ambiguous_or_missing_id" });
        continue;
      }
      const ownIndex = byId.get(raw.id);
      if (ownIndex !== undefined) rows[ownIndex] = { ...rows[ownIndex], deleted: true };
      else {
        byId.set(raw.id, rows.length);
        rows.push({ id: raw.id, deleted: true });
      }
      continue;
    }
    const incoming = publicRow(raw, raw.id && liveCounts.get(raw.id) === 1
      ? raw.id : repaired[index].id);
    const ownIndex = byId.get(incoming.id);
    if (ownIndex === undefined) {
      if (typeof incoming.text !== "string") continue;
      byId.set(incoming.id, rows.length);
      rows.push(localRows.length ? { id: incoming.id, text: incoming.text,
        source: incoming.source, timestamp: incoming.timestamp, importedUnlabeled: true } : incoming);
    } else {
      const own = rows[ownIndex];
      // A live row cannot resurrect a locally deleted row. Text changes on
      // an existing id still arrive; attribution and history remain local.
      rows[ownIndex] = { ...own,
        ...(incoming.text !== undefined && { text: incoming.text }),
        ...(incoming.timestamp !== undefined && { timestamp: incoming.timestamp }),
        ...(incoming.source !== undefined && { source: incoming.source }) };
    }
  }
  return { transcript: JSON.stringify({ version: 2,
    unknownNumberHighWater: local.unknownNumberHighWater, rows }),
    pendingUpload: localRows.some((row) => !cloudCounts.has(row.id)), quarantinedMarkers };
}

function publicRow(row, id) {
  return Object.fromEntries(["id", "text", "source", "timestamp", "speakerName",
    "speakerIsPlaceholder", "unknownNumber"].filter((key) =>
    key === "id" || (row[key] !== undefined &&
      !(key === "speakerName" && row.speakerIsPlaceholder))).map((key) =>
    [key, key === "id" ? id : row[key]]));
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
    const protectedAssignment = own.speakerLockSource === "user" ||
      (own.machineReason === "approved_voice" && own.speaker === row.speaker);
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
      machineReason: own.machineReason,
    } : row;
  });
  rows.push(...current.rows.filter((row) => !seen.has(row.id) &&
    (row.speakerLockSource === "user" || row.machineReason === "approved_voice" || row.deleted)));
  return writeTranscriptDocument(rows, Math.max(proposed.unknownNumberHighWater,
    current.unknownNumberHighWater));
}

export { readTranscriptDocument, writeTranscriptDocument, publicTranscript, isTranscriptDocument,
  allocateUnknownNumbers, mergeLocalTranscriptState, reconcileAutomaticTranscript,
  reconcileCloudTranscript, normalizeRowIds, migrateTranscriptDocument };
