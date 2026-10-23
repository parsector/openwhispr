function buildNoteSearchQuery(input) {
  if (typeof input !== "string") return "";

  const tokens = input
    .normalize("NFC")
    .match(/[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*/gu)
    ?.filter((token) => /[\p{L}\p{N}]/u.test(token));

  if (!tokens?.length) return "";

  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" ");
}

// Shared by the renderer IPC handler and the local MCP server.
async function searchNotes({ database, getSemanticSearch, query, limit = 5, spaceId, folderId, logger }) {
  try {
    const overFetch = folderId != null ? limit * 4 : limit * 2;
    const vectorFilter = spaceId != null
      ? { must: [{ key: "space_id", match: { value: spaceId } }] }
      : undefined;
    const [ftsResults, vectorResults] = await Promise.all([
      database.searchNotes(query, overFetch, spaceId, folderId),
      getSemanticSearch?.()?.search(query, overFetch, vectorFilter),
    ]);
    if (vectorResults == null) return ftsResults.slice(0, limit);
    const scopedIds = new Set(database.getNoteIdsInScope(
      spaceId, folderId, vectorResults.map(({ noteId }) => noteId)
    ));
    const filtered = vectorResults.filter(({ noteId, score }) => score > 0.3 && scopedIds.has(noteId));
    const scores = new Map();
    ftsResults.forEach((note, i) => scores.set(note.id, (scores.get(note.id) || 0) + 1 / (60 + i)));
    filtered.forEach(({ noteId }, i) => scores.set(noteId, (scores.get(noteId) || 0) + 1 / (60 + i)));
    const rankedIds = [...scores.entries()].sort((a, b) => b[1] - a[1])
      .slice(0, limit).map(([id]) => id);
    const noteMap = new Map(ftsResults.map((note) => [note.id, note]));
    for (const id of rankedIds) {
      if (!noteMap.has(id)) {
        const note = database.getNote(id);
        if (note) noteMap.set(id, note);
      }
    }
    return rankedIds.map((id) => noteMap.get(id)).filter(Boolean);
  } catch (error) {
    logger?.error("Semantic search failed, falling back to FTS5", { error: error.message });
    return database.searchNotes(query, limit, spaceId, folderId);
  }
}

module.exports = { buildNoteSearchQuery, searchNotes };
