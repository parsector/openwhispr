import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { loadFolders } from "../../stores/noteStore";

type Routine = Awaited<ReturnType<Window["electronAPI"]["listRoutines"]>>[number];
type Preset = Awaited<ReturnType<Window["electronAPI"]["routinePresets"]>>[number];
type Slot = { days: number[]; time: string };
type Draft = {
  id?: string;
  name: string;
  prompt: string;
  allowed_tools: string[];
  trigger_config: { schema_version: number; slots: Slot[] };
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
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  multiline?: boolean;
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
      dir="auto"
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
  const refresh = useCallback(async () => {
    setRoutines(await window.electronAPI.listRoutines());
    if (historyId) setHistory(await window.electronAPI.routineHistory(historyId));
  }, [historyId]);
  useEffect(() => {
    void refresh();
    void window.electronAPI.routinePresets().then(setPresets);
    return window.electronAPI.onRoutinesUpdated(() => {
      void refresh();
    });
  }, [refresh]);
  const edit = (routine: Routine) => {
    setDraft({
      id: routine.id,
      name: routine.name,
      prompt: routine.prompt,
      allowed_tools: routine.allowed_tools,
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
            slots: current.trigger_config.slots.map((item, i) => (i === index ? slot : item)),
          },
        }
    );
  const save = async () => {
    if (!draft) return;
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
              {fromPreset.needs.map((key) => t(key)).join(" · ")}
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
          <div className="space-y-3">
            <span className="text-sm font-medium">{t("routines.timeTrigger")}</span>
            {draft.trigger_config.slots.map((slot, index) => (
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
                  {draft.trigger_config.slots.length > 1 && (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          trigger_config: {
                            ...draft.trigger_config,
                            slots: draft.trigger_config.slots.filter((_, i) => i !== index),
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
            {draft.trigger_config.slots.length < 6 && (
              <Button
                variant="ghost"
                onClick={() =>
                  setDraft({
                    ...draft,
                    trigger_config: {
                      ...draft.trigger_config,
                      slots: [
                        ...draft.trigger_config.slots,
                        { days: [1, 2, 3, 4, 5], time: "09:00" },
                      ],
                    },
                  })
                }
              >
                {t("routines.addSlot")}
              </Button>
            )}
          </div>
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
                  {t("routines.timeTrigger")}:{" "}
                  {routine.trigger_config.slots
                    .map(
                      (slot) =>
                        `${slot.days.map((day) => t(`routines.days.${day}`)).join("/")} ${slot.time}`
                    )
                    .join(", ")}{" "}
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
                </div>
              </section>
            ))}
          </div>
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
                </button>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
