export function boundedDateLabel(label: string, numericDate: string, kind: "semantic" | "composed"): string {
  const maxLength = kind === "semantic" ? 12 : 8;
  return [...label].length > maxLength ? numericDate : label;
}
