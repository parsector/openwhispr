export type Source = {
  id: string;
  label: string;
  tools: string[];
  reason?: "needsApproval" | "notConnected" | "noTools";
};

export function sourceState(
  source: Source,
  allowed: string[]
): "off" | "on" | "partial" | "disabled" {
  if (!source.tools.length) return "disabled";
  const count = source.tools.filter((tool) => allowed.includes(tool)).length;
  return count === source.tools.length ? "on" : count ? "partial" : "off";
}

export function customTools(sources: Source[], allowed: string[]): string[] {
  const known = new Set(sources.flatMap((source) => source.tools));
  return allowed.filter((tool) => !known.has(tool));
}

export function toggleSource(source: Source, allowed: string[]): string[] {
  if (!source.tools.length) return allowed;
  const selected = sourceState(source, allowed) === "on";
  return selected
    ? allowed.filter((tool) => !source.tools.includes(tool))
    : [...new Set([...allowed, ...source.tools])];
}

export type Selection = {
  folder_ids: number[] | null;
  people: string[] | null;
  lookback_days: number;
};
export const defaultSelection = (): Selection => ({
  folder_ids: null,
  people: null,
  lookback_days: 7,
});

export function missingRequiredSelection(
  selection: Selection | null,
  required: string[]
): { folders: boolean; people: boolean } {
  return {
    folders:
      required.includes("folders") &&
      Array.isArray(selection?.folder_ids) &&
      selection.folder_ids.length === 0,
    people:
      required.includes("people") &&
      Array.isArray(selection?.people) &&
      selection.people.length === 0,
  };
}

export function nextThreeRuns(slots: Array<{ days: number[]; time: string }>, now: Date): Date[] {
  const runs: Date[] = [];
  for (let offset = 0; offset < 15 && runs.length < 3; offset++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    for (const slot of slots) {
      if (!slot.days.includes(day.getDay()) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time))
        continue;
      const [hour, minute] = slot.time.split(":").map(Number);
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
      if (at > now && !runs.some((run) => run.getTime() === at.getTime())) runs.push(at);
    }
    runs.sort((a, b) => a.getTime() - b.getTime());
    if (runs.length > 3) runs.length = 3;
  }
  return runs;
}
