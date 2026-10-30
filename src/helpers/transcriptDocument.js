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

// The only number allocator. Call it with the complete note and the note's
// persisted high-water mark before displaying or saving rows.
function allocateUnknownNumbers(rows, noteHighWater = 0) {
  const numbers = new Map();
  let next = Math.max(noteHighWater, 0, ...rows.map((row) =>
    Math.max(row.unknownNumber || 0, row.unknownNumberHighWater || 0))) + 1;
  for (const row of rows) {
    if (row.speaker && row.unknownNumber)
      numbers.set(`${row.diarizationRunId || "legacy"}:${row.speaker}`, row.unknownNumber);
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
  const numbered = allocateUnknownNumbers(rows, unknownNumberHighWater);
  const visible = numbered.map((row) => Object.fromEntries(
    fields.filter((field) => row[field] !== undefined).map((field) => [field, row[field]])
  ));
  return JSON.stringify({ version: 2, unknownNumberHighWater: Math.max(unknownNumberHighWater,
    ...numbered.map((row) => row.unknownNumber || 0), 0), rows: visible });
}

function mergeLocalTranscriptState(cloudRaw, localRaw) {
  if (!isTranscriptDocument(cloudRaw) || !isTranscriptDocument(localRaw)) return cloudRaw;
  const cloud = readTranscriptDocument(cloudRaw);
  const local = readTranscriptDocument(localRaw);
  const localById = new Map(local.rows.filter((row) => row.id).map((row) => [row.id, row]));
  let retained = false;
  const rows = cloud.rows.map((row) => {
    const own = localById.get(row.id);
    if (!own) return row;
    const sameLabel = own.speakerName === row.speakerName &&
      !!own.speakerIsPlaceholder === !!row.speakerIsPlaceholder &&
      !!own.speakerLocked === !!row.speakerLocked;
    if (!own.corrections?.length && (!sameLabel ||
        (!own.suggestedName && own.suggestedProfileId == null && !own.uncertainty))) return row;
    retained = true;
    return { ...row,
      corrections: own.corrections,
      ...(sameLabel ? { suggestedName: own.suggestedName,
        suggestedProfileId: own.suggestedProfileId, uncertainty: own.uncertainty } : {}),
    };
  });
  if (!retained && local.unknownNumberHighWater <= cloud.unknownNumberHighWater) return cloudRaw;
  return writeTranscriptDocument(rows, Math.max(cloud.unknownNumberHighWater,
    local.unknownNumberHighWater));
}

export { readTranscriptDocument, writeTranscriptDocument, publicTranscript, isTranscriptDocument,
  allocateUnknownNumbers, mergeLocalTranscriptState };
