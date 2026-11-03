const { readTranscriptDocument } = require("../transcriptDocument");

function logSkipped(message, details) {
  require("../debugLogger").debug(message, details, "commitments");
}

// Match the renderer's transcript document reader: legacy arrays and v2 rows
// are the stored shapes. Deleted rows are not visible transcript segments.
function parseSegments(raw, noteId, logDebug = logSkipped) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    logDebug("Commitment transcript skipped", { noteId, shape: "invalid_json", version: null });
    return [];
  }
  const shape = Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed;
  const version =
    !Array.isArray(parsed) && parsed && typeof parsed === "object"
      ? (parsed.version ?? null)
      : null;
  const validShape =
    Array.isArray(parsed) ||
    (parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (!Object.hasOwn(parsed, "version") || version === 2) &&
      Array.isArray(parsed.rows));
  if (!validShape) {
    logDebug("Commitment transcript skipped", {
      noteId,
      shape,
      version,
      reason: "unsupported_shape_or_version",
    });
    return [];
  }
  const rows = (
    typeof raw === "string"
      ? readTranscriptDocument(raw).rows
      : Array.isArray(parsed)
        ? parsed
        : parsed.rows
  ).filter(
    (row) =>
      row &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      !row.deleted &&
      typeof row.text === "string" &&
      row.text.trim()
  );
  if (!rows.length)
    logDebug("Commitment transcript skipped", {
      noteId,
      shape: Array.isArray(parsed) ? "array" : "rows",
      version,
      reason: "no_spoken_rows",
    });
  return rows;
}

module.exports = { parseSegments };
