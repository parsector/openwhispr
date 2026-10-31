// Word times come only from a local recognizer's timed decode of the recording.
// Text matching is deliberately strict: a different decode is not alignment.
const canonical = (value) => String(value || "").normalize("NFKC")
  .replace(/[^\p{L}\p{N}]/gu, "").toLocaleLowerCase();

function alignTranscriptRows(rows, decoded) {
  const words = (decoded || []).filter((word) =>
    canonical(word.text) && Number.isFinite(word.start) &&
    Number.isFinite(word.end) && word.start >= 0 && word.end > word.start);
  let cursor = 0;
  return rows.map((row) => {
    const tokens = String(row.text || "").trim().split(/\s+/u).filter(Boolean);
    if (!tokens.length) return row;
    const matches = [];
    for (let start = cursor; start + tokens.length <= words.length; start += 1) {
      if (!tokens.every((token, i) => canonical(token) === canonical(words[start + i].text))) continue;
      const slice = words.slice(start, start + tokens.length);
      if (slice.some((word, i) => i && word.start < slice[i - 1].end)) continue;
      matches.push(start);
    }
    // Repeated text has no trustworthy address without another anchor.
    if (matches.length !== 1) return row;
    const start = matches[0];
    cursor = start + tokens.length;
    return { ...row, wordTimings: tokens.map((token, i) => ({
      word: token, start: words[start + i].start, end: words[start + i].end,
    })) };
  });
}

function timedWordsFromWhisper(response) {
  if (!Array.isArray(response?.segments)) return [];
  // max_len=1 + split_on_word makes a segment per word in whisper.cpp.
  // Refuse a multiword segment rather than distributing its time by length.
  return response.segments.flatMap((segment) => {
    const text = String(segment.text || "").trim();
    return text && !/\s/u.test(text) && Number.isFinite(segment.start) &&
      Number.isFinite(segment.end) && segment.end > segment.start
      ? [{ text, start: segment.start, end: segment.end }] : [];
  });
}

// The mic capture used for diarization is released after a call starts. Its
// encrypted local recording remains available, so decode it in bounded pieces
// at stop without retaining a second full-meeting PCM buffer in the live path.
async function timedWordsFromStoredTrack({ noteId, track, durationSeconds, store, transcribe }) {
  const words = [];
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return words;
  const chunks = store.status?.(noteId)?.tracks?.[track]?.chunks;
  const regions = [];
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) {
      const start = chunk.startSample / 24000;
      const end = (chunk.startSample + chunk.sampleCount) / 24000;
      const last = regions.at(-1);
      if (last && start <= last.end) last.end = Math.max(last.end, end);
      else regions.push({ start, end });
    }
  } else regions.push({ start: 0, end: durationSeconds });
  for (const region of regions) for (let coreStart = region.start; coreStart < region.end; coreStart += 90) {
    const coreEnd = Math.min(region.end, coreStart + 90);
    const windowStart = Math.max(region.start, coreStart - 5);
    const windowEnd = Math.min(region.end, coreEnd + 5);
    const audio = store.span(noteId, track, windowStart, windowEnd);
    if (audio.state !== "available" || audio.partial) continue;
    const decoded = timedWordsFromWhisper(await transcribe(audio.wav));
    for (const word of decoded) {
      const start = windowStart + word.start;
      const end = windowStart + word.end;
      const midpoint = (start + end) / 2;
      if (midpoint >= coreStart && midpoint < coreEnd)
        words.push({ text: word.text, start, end });
    }
  }
  return words;
}

function withAudioSpans(rows, recordingId, offsets = {}) {
  return rows.map((row) => {
    const tokens = String(row.text || "").trim().split(/\s+/u).filter(Boolean);
    const words = row.wordTimings;
    if (!tokens.length || !Array.isArray(words) || tokens.length !== words.length ||
      words.some((word, i) => canonical(word.word) !== canonical(tokens[i]) ||
        !Number.isFinite(word.start) || !Number.isFinite(word.end) ||
        word.start < 0 || word.end <= word.start ||
        (i && word.start < words[i - 1].end))) {
      const unaligned = { ...row };
      delete unaligned.wordTimings;
      delete unaligned.audioSpan;
      return unaligned;
    }
    const offset = offsets[row.source] || 0;
    return { ...row, audioSpan: {
      recordingId, trackId: row.source,
      startSample: Math.round((offset + words[0].start) * 24000),
      endSample: Math.round((offset + words.at(-1).end) * 24000),
    } };
  });
}

module.exports = { alignTranscriptRows, timedWordsFromWhisper, timedWordsFromStoredTrack,
  withAudioSpans };
