/** The existing lightweight note content hash, shared by generation and the editor. */
export function makeContentHash(content: string): string {
  return String(content.length) + "-" + content.slice(0, 50);
}

const SUMMARY_HASH_SEPARATOR = "\n#summary-hash:";

export function withSummaryHash(materialHash: string, summary: string): string {
  return `${materialHash}${SUMMARY_HASH_SEPARATOR}${makeContentHash(summary)}`;
}

export function materialHashOf(storedHash: string): string {
  return storedHash.split(SUMMARY_HASH_SEPARATOR, 1)[0];
}

export function summaryWasHandEdited(
  summary: string | null | undefined,
  storedHash: string | null | undefined
): boolean {
  if (!summary || !storedHash) return false;
  const marker = storedHash.indexOf(SUMMARY_HASH_SEPARATOR);
  if (marker < 0) return false;
  return makeContentHash(summary) !== storedHash.slice(marker + SUMMARY_HASH_SEPARATOR.length);
}
