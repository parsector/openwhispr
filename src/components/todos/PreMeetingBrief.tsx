import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Commitment } from "../../types/electron";
import type { BriefPerson } from "./preMeetingBrief";

function BriefRow({ row, onComplete }: { row: Commitment; onComplete: (row: Commitment) => void }) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();
  return <div className="border-t border-border/50 py-1.5 text-[11px]">
    <div className="flex items-start gap-2">
      <button type="button" aria-label={t("todos.briefComplete", { text: row.text })} onClick={() => onComplete(row)} className="shrink-0 text-primary hover:underline">✓</button>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="min-w-0 flex-1 text-start">
        <span className="block truncate">{row.text}</span>
      </button>
      <span className="shrink-0 rounded-full bg-muted px-1.5 text-muted-foreground">{row.due_date || t("todos.briefNoDate")}</span>
    </div>
    {expanded && row.quote && <blockquote className="ms-5 mt-1 border-s border-border ps-2 text-muted-foreground">“{row.quote}”</blockquote>}
  </div>;
}

export default function PreMeetingBrief({ people, onComplete, onMore }: {
  people: BriefPerson[]; onComplete: (row: Commitment) => void; onMore: (person: BriefPerson) => void;
}) {
  const { t } = useTranslation();
  if (!people.length) return null;
  return <section className="mt-2 max-h-72 overflow-y-auto border-t border-border/70 pt-2 text-foreground">
    <h2 className="text-xs font-semibold">{t("todos.briefTitle")}</h2>
    {people.map((person) => <div key={person.label} className="mt-2">
      <h3 className="text-[11px] font-medium text-muted-foreground">{person.label}</h3>
      {([ ["briefOwe", person.owe, person.oweMore], ["briefWaiting", person.waiting, person.waitingMore] ] as const).map(([title, rows, more]) => rows.length > 0 && <div key={title} className="mt-1">
        <h4 className="text-[11px] font-semibold">{t(`todos.${title}`)}</h4>
        {rows.map((row) => <BriefRow key={row.id} row={row} onComplete={onComplete} />)}
        {more > 0 && <button type="button" className="text-[11px] text-primary underline" onClick={() => onMore(person)}>{t("todos.briefMore", { count: more })}</button>}
      </div>)}
    </div>)}
  </section>;
}
