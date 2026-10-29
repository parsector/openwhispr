import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "../icons";

function dateValue(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export default function TodoDatePicker({ value, onSelect }: { value: string | null; onSelect: (date: string) => void }) {
  const { i18n, t } = useTranslation();
  const [month, setMonth] = useState(() => value ? new Date(`${value}T12:00:00`) : new Date());
  const start = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = start.getDay();
  const days = Array.from({ length: 42 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), index - offset + 1));
  const monthLabel = new Intl.DateTimeFormat(i18n.language, { month: "long", year: "numeric" }).format(start);
  const weekday = new Intl.DateTimeFormat(i18n.language, { weekday: "narrow" });
  const full = new Intl.DateTimeFormat(i18n.language, { dateStyle: "full" });
  const changeMonth = (delta: number) => setMonth(new Date(start.getFullYear(), start.getMonth() + delta, 1));
  return <div aria-label={t("todos.pickDate")} className="w-60 p-2 text-xs">
    <div className="mb-2 flex items-center justify-between gap-2">
      <button type="button" aria-label={new Intl.DateTimeFormat(i18n.language, { month: "long", year: "numeric" }).format(new Date(start.getFullYear(), start.getMonth() - 1, 1))} onClick={() => changeMonth(-1)} className="rounded p-1 hover:bg-muted"><ChevronLeft size={15} /></button>
      <span className="font-medium">{monthLabel}</span>
      <button type="button" aria-label={new Intl.DateTimeFormat(i18n.language, { month: "long", year: "numeric" }).format(new Date(start.getFullYear(), start.getMonth() + 1, 1))} onClick={() => changeMonth(1)} className="rounded p-1 hover:bg-muted"><ChevronRight size={15} /></button>
    </div>
    <div className="grid grid-cols-7 gap-0.5 text-center">
      {days.slice(0, 7).map((day) => <span key={`heading-${day.getDay()}`} className="py-1 text-muted-foreground">{weekday.format(day)}</span>)}
      {days.map((day) => { const selected = dateValue(day) === value; return <button key={dateValue(day)} type="button" aria-label={full.format(day)} aria-pressed={selected} onClick={() => onSelect(dateValue(day))}
        className={`rounded py-1 focus-visible:outline-2 focus-visible:outline-primary ${selected ? "bg-primary text-primary-foreground" : day.getMonth() === start.getMonth() ? "text-foreground hover:bg-muted" : "text-muted-foreground/50 hover:bg-muted"}`}>{day.getDate()}</button>; })}
    </div>
  </div>;
}
