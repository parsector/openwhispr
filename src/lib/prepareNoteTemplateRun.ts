import { summaryWasHandEdited } from "./noteSummaryHash";

/** Saves pending edits before a runner fetches the note, then protects hand edits. */
export async function prepareNoteTemplateRun(options: {
  flush: () => Promise<void>;
  isTemplate: boolean;
  summary: string | null | undefined;
  storedHash: string | null | undefined;
  handEditConfirmed: boolean;
  requestConfirmation: () => void;
  reportSaveError: (error: unknown) => void;
}): Promise<boolean> {
  try {
    await options.flush();
  } catch (error) {
    options.reportSaveError(error);
    return false;
  }
  if (
    options.isTemplate &&
    !options.handEditConfirmed &&
    summaryWasHandEdited(options.summary, options.storedHash)
  ) {
    options.requestConfirmation();
    return false;
  }
  return true;
}
