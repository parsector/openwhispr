import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { loadFolders, useFolders } from "../../stores/noteStore";
import { routineEndpointSupportsTools } from "../../utils/modelCapability";

type Routine = Awaited<ReturnType<Window["electronAPI"]["listRoutines"]>>[number];
type Preset = Awaited<ReturnType<Window["electronAPI"]["routinePresets"]>>[number];
type Slot = { days: number[]; time: string };
type TriggerConfig = { schema_version: number; slots?: Slot[]; minutes_before?: number; title_pattern?: string; has_attendees?: boolean; has_meeting_link?: boolean; skip_declined?: boolean; folder_ids?: number[] };
type ModelChoice = { mode: string; provider: string; model: string; remoteUrl: string };
type Draft = {
  id?: string;
  name: string;
  prompt: string;
  allowed_tools: string[];
  source_config: { folder_ids: number[]; people: string[]; lookback_days: number } | null;
  model_override: ModelChoice | null;
  catch_up_window_hours: number;
  voice_hint: string;
  trigger_type: string;
  trigger_config: TriggerConfig;
};
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, minute) => String(minute).padStart(2, "0"));
const SAVE_ERROR_KEYS: Record<string, string> = {
  "A folder with that name already exists": "routines.errors.folderNameTaken",
  "Name and prompt are required": "routines.errors.nameAndPrompt",
  "Choose between 1 and 6 time slots": "routines.errors.slotCount",
  "Invalid time slot": "routines.errors.invalidSlot",
};

function PlainTextField({
  value,
  onChange,
  label,
  multiline = false,
  direction = "auto",
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  multiline?: boolean;
  direction?: "auto" | "ltr";
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current && ref.current.textContent !== value)
      ref.current.textContent = value;
  }, [value]);
  return (
    <div
      ref={ref}
      role="textbox"
      aria-label={label}
      aria-multiline={multiline}
      dir={direction}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      onInput={(event) => onChange(event.currentTarget.innerText)}
      onKeyDown={(event) => {
        if (!multiline && event.key === "Enter") event.preventDefault();
      }}
      className={`w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/30 whitespace-pre-wrap ${multiline ? "min-h-32" : "min-h-10"}`}
    />
  );
}

function newDraft(preset?: Preset, translatedName = ""): Draft {
  return {
    name: translatedName,
    prompt: preset?.prompt || "",
    allowed_tools: preset?.suggested_tools || [],
    source_config: preset?.source_config || null,
    model_override: null,
    catch_up_window_hours: 4,
    voice_hint: "",
    trigger_type: preset?.trigger_type || "time",
    trigger_config: preset?.trigger_config || {
      schema_version: 1,
      slots: [{ days: [1, 2, 3, 4, 5], time: "09:00" }],
    },
  };
}

export default function RoutinesView({ onOpenNote }: { onOpenNote: (id: number) => void }) {
  const { t } = useTranslation();
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [fromPreset, setFromPreset] = useState<Preset | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [history, setHistory] = useState<
    Awaited<ReturnType<Window["electronAPI"]["routineHistory"]>>
  >([]);
  const [error, setError] = useState("");
  const [people, setPeople] = useState<Array<{ email: string; name: string }>>([]);
  const [deleteTarget, setDeleteTarget] = useState<Routine | null>(null);
  const folders = useFolders().filter((folder) => !folder.routine_id && !folder.deleted_at);
  const [mcpSources, setMcpSources] = useState<Array<{ name: string; description: string }>>([]);
  const [scopeModel, setScopeModel] = useState<ModelChoice | null>(null);
  const [overrideUsable, setOverrideUsable] = useState(true);
  const [meetingPreview, setMeetingPreview] = useState<number | null>(null);
  const refresh = useCallback(async () => {
    setRoutines(await window.electronAPI.listRoutines());
    if (historyId) setHistory(await window.electronAPI.routineHistory(historyId));
  }, [historyId]);
  useEffect(() => {
    void refresh();
    void window.electronAPI.routinePresets().then(setPresets);
    void window.electronAPI.routinePeople().then(setPeople);
    void window.electronAPI
      .routineMcpSources()
      .then(setMcpSources)
      .catch(() => setMcpSources([]));
    void window.electronAPI.routineModelChoiceCurrent().then(setScopeModel);
    return window.electronAPI.onRoutinesUpdated(() => {
      void refresh();
    });
  }, [refresh]);
  useEffect(() => {
    if (!draft?.model_override) return;
    let active = true;
    void window.electronAPI
      .routineModelUsable(draft.model_override)
      .then((usable) => {
        if (active) setOverrideUsable(usable);
      })
      .catch(() => {
        if (active) setOverrideUsable(false);
      });
    return () => {
      active = false;
    };
  }, [draft?.model_override]);
  useEffect(() => {
    if (draft?.trigger_type !== "meeting_ended") { setMeetingPreview(null); return; }
    const config = draft.trigger_config;
    let active = true;
    void window.electronAPI.routineMeetingPreview({ schema_version: 1, folder_ids: config.folder_ids || [], title_pattern: config.title_pattern || "" })
      .then((count) => { if (active) setMeetingPreview(count); })
      .catch(() => { if (active) setMeetingPreview(null); });
    return () => { active = false; };
  }, [draft?.trigger_type, draft?.trigger_config]);
  const edit = (routine: Routine) => {
    setDraft({
      id: routine.id,
      name: routine.name,
      prompt: routine.prompt,
      allowed_tools: routine.allowed_tools,
      source_config: routine.source_config,
      model_override: routine.model_override,
      catch_up_window_hours: routine.catch_up_window_hours,
      voice_hint: routine.voice_hint || "",
      trigger_type: routine.trigger_type,
      trigger_config: routine.trigger_config,
    });
    setFromPreset(null);
    setError("");
  };
  const choose = (preset?: Preset) => {
    setDraft(newDraft(preset, preset ? t(preset.nameKey) : ""));
    setFromPreset(preset || null);
    setError("");
  };
  const updateSlot = (index: number, slot: Slot) =>
    setDraft(
      (current) =>
        current && {
          ...current,
          trigger_config: {
            ...current.trigger_config,
            slots: (current.trigger_config.slots || []).map((item, i) => (i === index ? slot : item)),
          },
        }
    );
  const save = async () => {
    if (!draft) return;
    if (draft.trigger_type === "meeting_ended" && !(draft.trigger_config.folder_ids?.length || draft.trigger_config.title_pattern?.trim())) {
      setError(t("routines.errors.meetingFilter")); return;
    }
    if (fromPreset?.id === "friday-digest" &&
      (!draft.source_config?.folder_ids.length || !draft.source_config.people.length)) {
      setError(t("routines.errors.digestSelection"));
      return;
    }
    let result;
    try {
      result = await window.electronAPI.saveRoutine(draft);
    } catch {
      setError(t("routines.saveFailed"));
      return;
    }
    if (!result.success) {
      setError(t(SAVE_ERROR_KEYS[result.error || ""] || "routines.saveFailed"));
      return;
    }
    setDraft(null);
    setFromPreset(null);
    setError("");
    void loadFolders();
    await refresh();
  };
  const showHistory = async (id: string) => {
    setHistoryId(id);
    setHistory(await window.electronAPI.routineHistory(id));
  };
  const effectiveModel =
    draft?.model_override && overrideUsable ? draft.model_override : scopeModel;
  const toolWarning =
    draft && draft.allowed_tools.length > 0 && !routineEndpointSupportsTools(effectiveModel);
  const sourceOptions = [
    { name: "search_notes", description: t("routines.sourceNotes") },
    { name: "get_note", description: t("routines.sourceNote") },
    { name: "get_calendar_events", description: t("routines.sourceCalendar") },
    ...mcpSources,
  ];

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6 text-foreground">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{t("routines.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("routines.description")}</p>
        </div>
        {!draft && <Button onClick={() => choose()}>{t("routines.new")}</Button>}
      </div>
      {!draft && error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {draft ? (
        <section className="space-y-4 rounded-xl border border-border p-5">
          <h2 className="font-medium">{draft.id ? t("routines.edit") : t("routines.new")}</h2>
          {fromPreset && (
            <p className="text-xs text-muted-foreground">
              {fromPreset.needs.filter((key) =>
                key.endsWith("pickFolders") ? !draft.source_config?.folder_ids.length :
                key.endsWith("pickPeople") ? !draft.source_config?.people.length : true
              ).map((key) => t(key)).join(" · ")}
            </p>
          )}
          <div className="block space-y-1 text-sm">
            <span>{t("routines.name")}</span>
            <PlainTextField
              label={t("routines.name")}
              value={draft.name}
              onChange={(value) => setDraft({ ...draft, name: value })}
            />
          </div>
          <div className="block space-y-1 text-sm">
            <span>{t("routines.prompt")}</span>
            <PlainTextField
              multiline
              label={t("routines.prompt")}
              value={draft.prompt}
              onChange={(value) => setDraft({ ...draft, prompt: value })}
            />
          </div>
          <label className="block text-sm">{t("routines.trigger")}
            <select className="ml-2 rounded-md border bg-background p-2" value={draft.trigger_type}
              onChange={(event) => {
                const type = event.target.value;
                setDraft({ ...draft, trigger_type: type, trigger_config: type === "time"
                  ? { schema_version: 1, slots: [{ days: [1, 2, 3, 4, 5], time: "09:00" }] }
                  : type === "before_event"
                    ? { schema_version: 1, minutes_before: 10, title_pattern: "", has_attendees: false, has_meeting_link: false, skip_declined: true }
                    : { schema_version: 1, folder_ids: [], title_pattern: "" } });
              }}>
              <option value="time">{t("routines.timeTrigger")}</option>
              <option value="before_event">{t("routines.beforeEvent")}</option>
              <option value="meeting_ended">{t("routines.meetingEnded")}</option>
            </select>
          </label>
          {draft.trigger_type === "time" && <div className="space-y-3">
            <span className="text-sm font-medium">{t("routines.timeTrigger")}</span>
            {(draft.trigger_config.slots || []).map((slot, index) => (
              <div key={index} className="rounded-lg border border-border p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <select
                    aria-label={t("routines.hour")}
                    dir="ltr"
                    value={slot.time.slice(0, 2)}
                    onChange={(event) =>
                      updateSlot(index, {
                        ...slot,
                        time: `${event.target.value}:${slot.time.slice(3)}`,
                      })
                    }
                    className="rounded-md border border-border bg-background p-2 text-sm"
                  >
                    {HOURS.map((hour) => (
                      <option key={hour} value={hour}>
                        {hour}
                      </option>
                    ))}
                  </select>
                  <span>:</span>
                  <select
                    aria-label={t("routines.minute")}
                    dir="ltr"
                    value={slot.time.slice(3)}
                    onChange={(event) =>
                      updateSlot(index, {
                        ...slot,
                        time: `${slot.time.slice(0, 2)}:${event.target.value}`,
                      })
                    }
                    className="rounded-md border border-border bg-background p-2 text-sm"
                  >
                    {MINUTES.map((minute) => (
                      <option key={minute} value={minute}>
                        {minute}
                      </option>
                    ))}
                  </select>
                  {(draft.trigger_config.slots || []).length > 1 && (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          trigger_config: {
                            ...draft.trigger_config,
                            slots: (draft.trigger_config.slots || []).filter((_, i) => i !== index),
                          },
                        })
                      }
                    >
                      {t("routines.removeSlot")}
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {ALL_DAYS.map((day) => (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={slot.days.includes(day)}
                      className={`rounded-md border px-2 py-1 text-xs ${slot.days.includes(day) ? "border-primary bg-primary/10" : "border-border"}`}
                      onClick={() =>
                        updateSlot(index, {
                          ...slot,
                          days: slot.days.includes(day)
                            ? slot.days.filter((item) => item !== day)
                            : [...slot.days, day].sort(),
                        })
                      }
                    >
                      {t(`routines.days.${day}`)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {(draft.trigger_config.slots || []).length < 6 && (
              <Button
                variant="ghost"
                onClick={() =>
                  setDraft({
                    ...draft,
                    trigger_config: {
                      ...draft.trigger_config,
                      slots: [
                        ...(draft.trigger_config.slots || []),
                        { days: [1, 2, 3, 4, 5], time: "09:00" },
                      ],
                    },
                  })
                }
              >
                {t("routines.addSlot")}
              </Button>
            )}
          </div>}
          {draft.trigger_type === "before_event" && <div className="space-y-2 text-sm">
            <div>{t("routines.minutesBefore")}
              <PlainTextField label={t("routines.minutesBefore")} direction="ltr"
                value={String(draft.trigger_config.minutes_before ?? 10)}
                onChange={(value) => setDraft({ ...draft, trigger_config: { ...draft.trigger_config, minutes_before: Number(value) } })} />
            </div>
            <div>{t("routines.titlePattern")}
              <PlainTextField label={t("routines.titlePattern")} value={draft.trigger_config.title_pattern || ""}
                onChange={(value) => setDraft({ ...draft, trigger_config: { ...draft.trigger_config, title_pattern: value } })} />
            </div>
            {(["has_attendees", "has_meeting_link", "skip_declined"] as const).map((key) => <button key={key} type="button"
              aria-pressed={!!draft.trigger_config[key]} className="block w-full rounded-md border border-border p-2 text-start"
              onClick={() => setDraft({ ...draft, trigger_config: { ...draft.trigger_config, [key]: !draft.trigger_config[key] } })}>
              {draft.trigger_config[key] ? "☑" : "☐"} {t(`routines.${key}`)}
            </button>)}
          </div>}
          {draft.trigger_type === "meeting_ended" && <div className="space-y-2 text-sm">
            <p>{t("routines.meetingFolders")}</p>
            {folders.map((folder) => <button key={folder.id} type="button" className="block w-full rounded-md border border-border p-2 text-start"
              aria-pressed={(draft.trigger_config.folder_ids || []).includes(folder.id)}
              onClick={() => { const selected = (draft.trigger_config.folder_ids || []).includes(folder.id);
                setDraft({ ...draft, trigger_config: { ...draft.trigger_config, folder_ids: selected
                  ? (draft.trigger_config.folder_ids || []).filter((id) => id !== folder.id)
                  : [...(draft.trigger_config.folder_ids || []), folder.id] } }); }}>
              {(draft.trigger_config.folder_ids || []).includes(folder.id) ? "☑" : "☐"} {folder.name}
            </button>)}
            <div>{t("routines.titlePattern")}
              <PlainTextField label={t("routines.titlePattern")} value={draft.trigger_config.title_pattern || ""}
                onChange={(value) => setDraft({ ...draft, trigger_config: { ...draft.trigger_config, title_pattern: value } })} />
            </div>
            <p role="status">{meetingPreview == null ? t("routines.previewUnavailable") : t("routines.meetingPreview", { count: meetingPreview })}</p>
          </div>}
          <div className="space-y-2">
            <p className="text-sm font-medium">{t("routines.allowedTools")}</p>
            {sourceOptions.map((source) => (
              <button
                key={source.name}
                type="button"
                aria-pressed={draft.allowed_tools.includes(source.name)}
                className="flex w-full items-start gap-2 rounded-md border border-border p-2 text-start text-sm"
                onClick={() =>
                  setDraft({
                    ...draft,
                    allowed_tools: draft.allowed_tools.includes(source.name)
                      ? draft.allowed_tools.filter((name) => name !== source.name)
                      : [...draft.allowed_tools, source.name],
                  })
                }
              >
                <span aria-hidden="true">
                  {draft.allowed_tools.includes(source.name) ? "☑" : "☐"}
                </span>
                <span>
                  <strong>{source.name}</strong> — {source.description}
                </span>
              </button>
            ))}
            {draft.allowed_tools
              .filter((name) => !sourceOptions.some((source) => source.name === name))
              .map((name) => (
                <button
                  key={name}
                  type="button"
                  aria-pressed
                  className="flex w-full gap-2 rounded-md border border-border p-2 text-start text-sm text-muted-foreground"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      allowed_tools: draft.allowed_tools.filter((item) => item !== name),
                    })
                  }
                >
                  <span aria-hidden="true">☑</span>
                  {name} ({t("routines.sourceUnavailable")})
                </button>
              ))}
          </div>
          <div className="space-y-3 text-sm">
            <p className="font-medium">{t("routines.selectedNotes")}</p>
            <button type="button" aria-pressed={!!draft.source_config}
              className="flex w-full gap-2 rounded-md border border-border p-2 text-start"
              onClick={() => setDraft({ ...draft, source_config: draft.source_config
                ? null : { folder_ids: [], people: [], lookback_days: 7 } })}>
              <span aria-hidden="true">{draft.source_config ? "☑" : "☐"}</span>
              {t("routines.useSelectedNotes")}
            </button>
            {draft.source_config && <>
              <fieldset className="space-y-1"><legend>{t("routines.folders")}</legend>
                {folders.map((folder) => <button key={folder.id} type="button"
                  aria-pressed={draft.source_config!.folder_ids.includes(folder.id)}
                  className="flex w-full gap-2 rounded-md border border-border p-2 text-start"
                  onClick={() => { const selected = draft.source_config!.folder_ids.includes(folder.id);
                    setDraft({ ...draft, source_config: { ...draft.source_config!, folder_ids: selected
                      ? draft.source_config!.folder_ids.filter((id) => id !== folder.id)
                      : [...draft.source_config!.folder_ids, folder.id] } }); }}>
                  <span aria-hidden="true">{draft.source_config!.folder_ids.includes(folder.id) ? "☑" : "☐"}</span>
                  {folder.name}
                </button>)}
              </fieldset>
              <fieldset className="space-y-1"><legend>{t("routines.people")}</legend>
                {people.map((person) => <button key={person.email} type="button"
                  aria-pressed={draft.source_config!.people.includes(person.email)}
                  className="flex w-full gap-2 rounded-md border border-border p-2 text-start"
                  onClick={() => { const selected = draft.source_config!.people.includes(person.email);
                    setDraft({ ...draft, source_config: { ...draft.source_config!, people: selected
                      ? draft.source_config!.people.filter((email) => email !== person.email)
                      : [...draft.source_config!.people, person.email] } }); }}>
                  <span aria-hidden="true">{draft.source_config!.people.includes(person.email) ? "☑" : "☐"}</span>
                  {person.name}
                </button>)}
              </fieldset>
              <label className="block">{t("routines.lookbackDays")}
                <select className="ml-2 rounded-md border bg-background p-2"
                  value={draft.source_config.lookback_days}
                  onChange={(event) => setDraft({ ...draft, source_config: {
                    ...draft.source_config!, lookback_days: Number(event.target.value),
                  } })}>
                  {Array.from({ length: 365 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
                </select>
              </label>
            </>}
          </div>
          <div className="space-y-2 text-sm">
            <label className="block">
              {t("routines.modelOverride")}
              <select
                className="ml-2 rounded-md border border-border bg-background p-2"
                value={draft.model_override ? "override" : "scope"}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    model_override:
                      event.target.value === "override"
                        ? scopeModel || {
                            mode: "providers",
                            provider: "openai",
                            model: "",
                            remoteUrl: "",
                          }
                        : null,
                  })
                }
              >
                <option value="scope">{t("routines.model.sameAsChat")}</option>
                <option value="override">{t("routines.model.custom")}</option>
              </select>
            </label>
            {draft.model_override && (
              <div className="grid grid-cols-2 gap-2">
                {(["mode", "provider", "model", "remoteUrl"] as const).map((field) => (
                  <label key={field}>
                    {t(`routines.modelFields.${field}`)}
                    <PlainTextField
                      label={t(`routines.modelFields.${field}`)}
                      direction="ltr"
                      value={draft.model_override?.[field] || ""}
                      onChange={(value) =>
                        setDraft({
                          ...draft,
                          model_override: { ...draft.model_override!, [field]: value },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            )}
            {draft.model_override && !overrideUsable && (
              <p role="status" className="text-amber-700">
                {t("routines.unusableOverride")}
              </p>
            )}
            {toolWarning && (
              <p role="status" className="text-amber-700">
                {t("routines.needsToolModel", {
                  sources: draft.allowed_tools.map((name) => name.split("__")[0]).join(", "),
                })}
              </p>
            )}
          </div>
          <label className="block text-sm">
            {t("routines.catchUpWindow")}
            <PlainTextField
              label={t("routines.catchUpWindow")}
              direction="ltr"
              value={String(draft.catch_up_window_hours)}
              onChange={(value) => setDraft({ ...draft, catch_up_window_hours: Number(value) })}
            />
          </label>
          <label className="block text-sm">
            {t("routines.voiceHint")}
            <PlainTextField
              label={t("routines.voiceHint")}
              value={draft.voice_hint}
              onChange={(value) => setDraft({ ...draft, voice_hint: value.slice(0, 200) })}
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button onClick={() => void save()}>{t("routines.save")}</Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              {t("routines.cancel")}
            </Button>
          </div>
        </section>
      ) : (
        <>
          {routines.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("routines.empty")}</p>
          )}
          <div className="space-y-3">
            {routines.map((routine) => (
              <section key={routine.id} className="rounded-xl border border-border p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <h2 className="font-medium">{routine.name}</h2>
                  <span className="text-xs text-muted-foreground">
                    {routine.paused
                      ? t("routines.paused")
                      : routine.last_status
                        ? t(`routines.status.${routine.last_status}`)
                        : t("routines.active")}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {routine.trigger_type === "time" ? t("routines.timeTrigger") : routine.trigger_type === "before_event" ? t("routines.beforeEvent") : t("routines.meetingEnded")}:{" "}
                  {(routine.trigger_config.slots || [])
                    .map(
                      (slot) =>
                        `${slot.days.map((day) => t(`routines.days.${day}`)).join("/")} ${slot.time}`
                    )
                    .join(", ") || (routine.trigger_type === "before_event" ? `${routine.trigger_config.minutes_before} ${t("routines.minutesBefore")}` : routine.trigger_config.title_pattern || t("routines.meetingFolders"))}{" "}
                  · {t("routines.lastRun")}:{" "}
                  {routine.last_run_at
                    ? new Date(routine.last_run_at).toLocaleString()
                    : t("routines.never")}{" "}
                  · {t("routines.nextRun")}:{" "}
                  {routine.next_run_at
                    ? new Date(routine.next_run_at).toLocaleString()
                    : t("routines.never")}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      void window.electronAPI
                        .runRoutineNow(routine.id)
                        .then((result) => {
                          if (!result.success) setError(t("routines.runFailed"));
                        })
                        .catch(() => setError(t("routines.runFailed")));
                    }}
                  >
                    {t("routines.runNow")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void window.electronAPI
                        .pauseRoutine(routine.id, !routine.paused)
                        .then(refresh)
                    }
                  >
                    {routine.paused ? t("routines.resume") : t("routines.pause")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => edit(routine)}>
                    {t("routines.edit")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void showHistory(routine.id)}>
                    {t("routines.history")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(routine)}>
                    {t("routines.delete")}
                  </Button>
                </div>
              </section>
            ))}
          </div>
          {deleteTarget && <section role="dialog" aria-modal="true" aria-label={t("routines.delete")}
            className="rounded-xl border border-destructive p-4 space-y-3">
            <p>{t("routines.deleteQuestion", { name: deleteTarget.name })}</p>
            <div className="flex flex-wrap gap-2">
              <Button autoFocus onClick={async () => { const result = await window.electronAPI.deleteRoutine(deleteTarget.id, false);
                if (!result.success) setError(t("routines.deleteFailed"));
                setDeleteTarget(null); void loadFolders(); await refresh(); }}>
                {t("routines.keepFolder")}
              </Button>
              <Button variant="destructive" onClick={async () => { const result = await window.electronAPI.deleteRoutine(deleteTarget.id, true);
                if (!result.success) setError(t("routines.deleteFailed"));
                setDeleteTarget(null); void loadFolders(); await refresh(); }}>
                {t("routines.deleteFolderNotes")}
              </Button>
              <Button variant="ghost" onClick={() => setDeleteTarget(null)}>{t("routines.cancel")}</Button>
            </div>
          </section>}
          {historyId && (
            <section className="space-y-2">
              <h2 className="font-medium">{t("routines.history")}</h2>
              {history.map((run) => (
                <button
                  key={run.id}
                  className="block w-full rounded-md border border-border p-2 text-left text-sm"
                  onClick={() => run.note_id && onOpenNote(run.note_id)}
                >
                  {run.started_at ? new Date(run.started_at).toLocaleString() : t("routines.never")}{" "}
                  · {t(`routines.status.${run.status}`)} {run.error && `· ${run.error}`}
                </button>
              ))}
            </section>
          )}
          <section className="space-y-3">
            <h2 className="font-medium">{t("routines.gallery")}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                className="rounded-xl border border-border p-4 text-left hover:bg-muted"
                onClick={() => choose()}
              >
                <strong>{t("routines.scratch")}</strong>
              </button>
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  className="rounded-xl border border-border p-4 text-left hover:bg-muted"
                  onClick={() => choose(preset)}
                >
                  <strong>{t(preset.nameKey)}</strong>
                  <p className="mt-1 text-xs text-muted-foreground">{t(preset.descriptionKey)}</p>
                  {preset.needs.length > 0 && <p className="mt-1 text-xs text-amber-700">
                    {preset.needs.map((key) => t(key)).join(" · ")}
                  </p>}
                </button>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
