const STOP = new Set(["a", "an", "the", "to", "for", "of", "with", "on", "in", "at", "please", "i", "will", "ill", "we", "you", "it"]);
const VERB_FORMS = { sent: "send", sending: "send", shared: "share", sharing: "share", delivered: "deliver", delivering: "deliver", finished: "finish", finishing: "finish", completed: "complete", completing: "complete" };

function normaliseText(text) {
  return String(text || "")
    .trim()
    .replace(/^(?:(?:well|okay|so|um|uh)[, ]+)*/i, "")
    .replace(/^(?:i(?: will|'ll| am going to)|we(?: will|'ll))\s+/i, "")
    .replace(/(?:,?\s+please|\s+thanks|\s+thank you)[.!?]*$/i, "")
    .replace(/[.!?]+$/, "")
    .trim();
}

function tokens(text) {
  return new Set(normaliseText(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/)
    .filter((word) => word && !STOP.has(word)).map((word) => VERB_FORMS[word] || word));
}

function tokenSimilarity(a, b) {
  const left = tokens(a), right = tokens(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / new Set([...left, ...right]).size;
}

function people(person) {
  if (Array.isArray(person)) return person.map((item) => String(item).trim().toLowerCase()).sort();
  if (typeof person === "string" && person.startsWith("[")) {
    try { return people(JSON.parse(person)); } catch { /* treat as a name */ }
  }
  return person ? [String(person).trim().toLowerCase()] : [];
}

function samePeople(a, b) {
  return JSON.stringify(people(a)) === JSON.stringify(people(b));
}

function shouldMerge(a, b) {
  return a?.status === "open" && (a.direction || "owe") === (b.direction || "owe") &&
    samePeople(a.person, b.person) && tokenSimilarity(a.text, b.text) >= 0.75;
}

function matchCompletion(text, candidates, person = null) {
  return candidates.filter((row) => row.status === "open" && samePeople(row.person, person))
    .map((row) => ({ row, score: tokenSimilarity(text, row.text) }))
    .filter(({ score }) => score >= 0.6)
    .sort((a, b) => b.score - a.score)[0]?.row || null;
}

module.exports = { normaliseText, tokenSimilarity, shouldMerge, matchCompletion, samePeople };
