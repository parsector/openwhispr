import { MarkdownRenderer } from "./MarkdownRenderer";

interface ReleaseNotesProps {
  notes: string;
}

export function ReleaseNotes({ notes }: ReleaseNotesProps) {
  return (
    <div className="max-h-64 overflow-y-auto overscroll-contain pe-2 text-xs leading-relaxed text-muted-foreground wrap-break-word [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground">
      <MarkdownRenderer content={notes} />
    </div>
  );
}
