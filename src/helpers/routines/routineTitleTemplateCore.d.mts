export function defaultTitleTemplate(triggerType: string): string;
export function normalizeTitleTemplate(value: unknown): string | undefined;
export function renderRoutineTitle(input: {
  name: string;
  triggerType: string;
  titleTemplate?: string;
  event?: string | null;
  now?: Date | number;
}): string;
