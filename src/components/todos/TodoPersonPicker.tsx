import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import PersonAvatar from "../ui/PersonAvatar";

interface Person { id?: number; email: string | null; display_name: string }

export default function TodoPersonPicker({ value, onChange, onSelect, onCancel }: {
  value: string; onChange: (value: string) => void; onSelect: (value: string) => void; onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<Person[]>([]);
  const [contacts, setContacts] = useState<Person[]>([]);
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    let active = true;
    void window.electronAPI.getSpeakerProfiles?.().then((result) => {
      if (active) setProfiles((result || []).map((person) => ({ id: person.id, email: person.email, display_name: person.display_name })));
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    void window.electronAPI.searchContacts(value.trim()).then((result) => {
      if (active) { setContacts(result.success ? result.contacts.map((person) => ({ email: person.email, display_name: person.display_name || person.email })) : []); setSelected(0); }
    }).catch(() => { if (active) setContacts([]); });
    return () => { active = false; };
  }, [value]);
  const query = value.trim().toLocaleLowerCase();
  const seen = new Set<string>();
  const people = profiles.concat(contacts).filter((person) => {
    if (query && !person.display_name.toLocaleLowerCase().includes(query) && !person.email?.toLocaleLowerCase().includes(query)) return false;
    const key = person.email?.toLocaleLowerCase() || person.display_name.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
  const choose = (person: Person) => onSelect(person.display_name || person.email || "");
  return <div className="relative min-w-0 flex-1">
    <input autoFocus dir="auto" role="combobox" aria-label={t("todos.person")} aria-expanded={people.length > 0}
      aria-controls="todo-person-options" value={value} onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); onCancel(); }
        else if (event.key === "ArrowDown" && people.length) { event.preventDefault(); setSelected((index) => (index + 1) % people.length); }
        else if (event.key === "ArrowUp" && people.length) { event.preventDefault(); setSelected((index) => (index - 1 + people.length) % people.length); }
        else if (event.key === "Enter") { event.preventDefault(); if (query && people.length) choose(people[selected]); else onSelect(value); }
      }} className="w-full rounded border border-border bg-background px-2 py-1 text-sm" />
    {people.length > 0 && <div id="todo-person-options" role="listbox" className="absolute start-0 top-full z-30 mt-1 max-h-52 w-64 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg">
      {people.map((person, index) => <button type="button" role="option" aria-selected={index === selected} key={person.id ?? person.email ?? person.display_name}
        onMouseDown={(event) => event.preventDefault()} onClick={() => choose(person)}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs ${index === selected ? "bg-foreground/5 text-foreground" : "text-foreground/70 hover:bg-foreground/5"}`}>
        <PersonAvatar email={person.email} displayName={person.display_name} size={20} />
        <span className="min-w-0 flex-1 truncate">{person.display_name}</span>
        {person.email && person.display_name !== person.email && <span dir="ltr" className="truncate text-[11px] text-foreground/45">{person.email}</span>}
      </button>)}
    </div>}
  </div>;
}
