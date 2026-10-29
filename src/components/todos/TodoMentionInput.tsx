import { useEffect, useRef, useState } from "react";
import { buildMentionMarkdown } from "../../utils/mentionMarkdown";
import PersonAvatar from "../ui/PersonAvatar";

interface Contact { email: string | null; display_name: string | null }

export default function TodoMentionInput({ value, onChange, inputRef, label, rows = 2, placeholder, onEscape, onEnter, className }: {
  value: string; onChange: (value: string) => void; inputRef: React.RefObject<HTMLTextAreaElement | null>;
  label: string; rows?: number; placeholder?: string; onEscape: () => void; onEnter: () => void; className: string;
}) {
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selected, setSelected] = useState(0);
  const [caretPosition, setCaretPosition] = useState({ top: 26, left: 0 });
  const request = useRef(0);
  const dismissed = useRef<number | null>(null);
  const scan = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const match = before.match(/(^|[\s(])@([^\s@]*)$/);
    const start = match ? caret - match[2].length - 1 : -1;
    const lines = before.split("\n");
    const input = inputRef.current;
    if (input) {
      const style = window.getComputedStyle(input);
      const lineHeight = Number.parseFloat(style.lineHeight) || 20;
      const fontSize = Number.parseFloat(style.fontSize) || 14;
      setCaretPosition({ top: input.offsetTop + Math.min(lines.length, 3) * lineHeight + 4 - input.scrollTop,
        left: Math.min(input.clientWidth - 180, lines.at(-1)!.length * fontSize * 0.52 + 8) });
    }
    setTrigger(match && dismissed.current !== start ? { start, query: match[2] } : null);
  };
  useEffect(() => {
    const id = ++request.current;
    if (!trigger) { setContacts([]); return; }
    void window.electronAPI.searchContacts(trigger.query).then((result) => {
      if (id !== request.current) return;
      setContacts(result.success ? result.contacts.slice(0, 20).filter((person) => person.display_name || person.email) : []);
      setSelected(0);
    }).catch(() => { if (id === request.current) setContacts([]); });
  }, [trigger?.start, trigger?.query]);
  const choose = (person: Contact) => {
    if (!trigger) return;
    const name = person.display_name || person.email || "";
    if (!name) return;
    const input = inputRef.current;
    const caret = input?.selectionStart ?? value.length;
    const inserted = buildMentionMarkdown({ name, email: person.email });
    onChange(value.slice(0, trigger.start) + inserted + value.slice(caret));
    dismissed.current = null;
    setTrigger(null);
    window.requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(trigger.start + inserted.length, trigger.start + inserted.length); });
  };
  return <div className="relative">
    <textarea dir="auto" ref={inputRef} rows={rows} aria-label={label} placeholder={placeholder} value={value}
      onChange={(event) => { dismissed.current = null; onChange(event.target.value); scan(event.target.value, event.target.selectionStart); }}
      onClick={(event) => scan(value, event.currentTarget.selectionStart)}
      onKeyDown={(event) => {
        if (trigger && contacts.length) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSelected((index) => (index + (event.key === "ArrowDown" ? 1 : contacts.length - 1)) % contacts.length); return; }
          if (event.key === "Enter") { event.preventDefault(); choose(contacts[selected]); return; }
        }
        if (event.key === "Escape") { event.preventDefault(); if (trigger) { dismissed.current = trigger.start; setTrigger(null); } else onEscape(); return; }
        if (event.key === "Enter" && !event.shiftKey && !trigger) { event.preventDefault(); onEnter(); }
      }} className={className} />
    {trigger && contacts.length > 0 && <div role="listbox" aria-label={label} style={{ top: caretPosition.top, left: Math.max(0, caretPosition.left) }} className="absolute z-30 max-h-52 w-72 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg">
      {contacts.map((person, index) => <button type="button" role="option" aria-selected={index === selected} key={person.email || person.display_name || index}
        onMouseDown={(event) => event.preventDefault()} onClick={() => choose(person)} className="flex w-full items-center gap-2 rounded px-2 py-1 text-start text-xs hover:bg-foreground/5">
        <PersonAvatar email={person.email} displayName={person.display_name || person.email || ""} size={20} />
        <span className="truncate">{person.display_name || person.email}</span>
      </button>)}
    </div>}
  </div>;
}
