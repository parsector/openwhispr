import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUiLocale } from "../../hooks/useUiLocale";

type Person = Awaited<ReturnType<NonNullable<typeof window.electronAPI.listPeople>>>[number];
type Review = Awaited<ReturnType<NonNullable<typeof window.electronAPI.listPeopleReview>>>[number];
type Kind = "rename" | "merge" | "delete" | "reset";
type Request = { type: Kind; profileId: number; survivorId?: number; name?: string };
type Preview = { success: boolean; error?: string; noteCount?: number; segmentCount?: number; pinnedCount?: number; voiceSamples?: number };
const field = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";
const button = "rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export default function PeoplePage({ onOpenNote }: { onOpenNote?: (noteId: number, rowId: string) => void }) {
  const { t } = useTranslation();
  const locale = useUiLocale();
  const [tab, setTab] = useState<"people" | "review">("people");
  const [people, setPeople] = useState<Person[]>([]);
  const [review, setReview] = useState<Review[]>([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState(false);
  const [reviewReload, setReviewReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"usage" | "heard">("usage");
  const [reason, setReason] = useState("");
  const [personFilter, setPersonFilter] = useState("");
  const [limit, setLimit] = useState(100);
  const [selected, setSelected] = useState<Person | null>(null);
  const [kind, setKind] = useState<Kind>("rename");
  const [name, setName] = useState("");
  const [survivorId, setSurvivorId] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState("");
  const [report, setReport] = useState<{ id: string; name: string; type: Kind; count: number; segments: number } | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true); setError(false);
    try {
      if (!window.electronAPI.listPeople) throw Error("unavailable");
      setPeople(await window.electronAPI.listPeople());
    } catch { setError(true); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (tab !== "review" || loading || error) return;
    let alive = true;
    setReviewLoading(true); setReviewError(false);
    const load = window.electronAPI.listPeopleReview;
    if (!load) { setReviewError(true); setReviewLoading(false); return; }
    void load(personFilter ? Number(personFilter) : null)
      .then(rows => { if (alive) setReview(rows); })
      .catch(() => { if (alive) setReviewError(true); })
      .finally(() => { if (alive) setReviewLoading(false); });
    return () => { alive = false; };
  }, [tab, personFilter, loading, error, reviewReload]);
  const request: Request | null = selected ? { type: kind, profileId: selected.id,
    ...(kind === "rename" ? { name: name.trim() } : {}), ...(kind === "merge" ? { survivorId } : {}) } : null;
  const valid = !!request && (kind !== "rename" || !!name.trim()) && (kind !== "merge" || !!survivorId);
  useEffect(() => {
    if (!valid || !request) { setPreview(null); return; }
    let alive = true;
    setPreviewLoading(true); setPreview(null);
    void window.electronAPI.previewPersonAction?.(request).then(result => { if (alive) setPreview(result); })
      .catch(() => { if (alive) setPreview({ success: false, error: "persistence_failed" }); })
      .finally(() => { if (alive) setPreviewLoading(false); });
    return () => { alive = false; };
  }, [selected?.id, kind, name, survivorId, valid]);
  const shown = useMemo(() => people.filter(p => `${p.displayName} ${p.email || ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => sort === "usage" ? b.noteCount - a.noteCount || b.segmentCount - a.segmentCount || a.displayName.localeCompare(b.displayName)
      : (b.lastHeard || "").localeCompare(a.lastHeard || "") || a.displayName.localeCompare(b.displayName)), [people, query, sort]);
  const reasons = useMemo(() => [...new Set(review.map(r => r.reason).filter(r => r !== "person"))].sort(), [review]);
  const shownReview = useMemo(() => review.filter(r => (personFilter || r.reason !== "person") && (!reason || r.reason === reason) && (!personFilter || String(r.profileId) === personFilter)), [review, reason, personFilter]);
  const reasonLabel = (row: Review) => row.reason === "person" ? t("people.reasons.person")
    : row.reason === "unassessed" ? t("notes.speaker.notAssessed")
    : row.reason === "close_match" && row.candidates ? t("notes.speaker.reason.closeMatch", { first: row.candidates[0], second: row.candidates[1] })
    : t(`notes.speaker.reason.${row.reason}`, { defaultValue: t("people.reasons.uncertain") });
  const filterReasonLabel = (value: string) => value === "close_match" ? t("people.reasons.close_match") : reasonLabel({ reason: value, candidates: null } as Review);
  const start = (person: Person, action: Kind) => { setSelected(person); setKind(action); setName(person.displayName); setSurvivorId(0); setActionError(""); setReport(null); };
  const execute = async () => {
    if (!request || !preview?.success || working) return;
    setWorking(true); setActionError("");
    try {
      const result = await window.electronAPI.applyPersonAction?.({ ...request, expected: {
        noteCount: preview.noteCount || 0, segmentCount: preview.segmentCount || 0,
        pinnedCount: preview.pinnedCount || 0,
      } });
      if (!result?.success || !result.id) throw Error(result?.error || "persistence_failed");
      setReport({ id: result.id, name: selected!.displayName, type: kind, count: result.noteCount || 0, segments: result.segmentCount || 0 });
      setSelected(null); await refresh();
    } catch (cause) { setActionError(String(cause instanceof Error ? cause.message : cause)); }
    finally { setWorking(false); }
  };
  const undo = async () => {
    if (!report || working) return;
    setWorking(true); setActionError("");
    try {
      const result = await window.electronAPI.undoPersonAction?.(report.id);
      if (!result?.success) throw Error(result?.error || "persistence_failed");
      setReport(null); await refresh();
    } catch (cause) { setActionError(String(cause instanceof Error ? cause.message : cause)); }
    finally { setWorking(false); }
  };
  const date = (value: string | null) => value ? new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" }) : t("people.never");
  return <div className="space-y-5 pb-8 text-foreground">
    <div><h2 className="text-xl font-semibold tracking-tight">{t("people.title")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("people.subtitle")}</p></div>
    <div role="tablist" aria-label={t("people.title")} className="flex gap-1 border-b border-border">
      {(["people", "review"] as const).map(item => <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => setTab(item)} className={`px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${tab === item ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`}>{t(`people.tabs.${item}`)}</button>)}
    </div>
    {loading && <div role="status" className="space-y-2" aria-label={t("people.loading")}>{[0, 1, 2].map(i => <div key={i} className="h-16 animate-pulse rounded-lg bg-surface-2" />)}<p className="text-sm text-muted-foreground">{t("people.loading")}</p></div>}
    {error && !loading && <div role="alert" className="rounded-xl border border-destructive/30 p-5"><p className="font-medium">{t("people.loadError")}</p><button type="button" className={`${button} mt-3`} onClick={() => void refresh()}>{t("people.retry")}</button></div>}
    {!loading && !error && tab === "people" && <div role="tabpanel" className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]"><input dir="auto" className={field} aria-label={t("people.search")} placeholder={t("people.search")} value={query} onChange={e => setQuery(e.target.value)} /><select className={field} aria-label={t("people.sort")} value={sort} onChange={e => setSort(e.target.value as typeof sort)}><option value="usage">{t("people.sortUsage")}</option><option value="heard">{t("people.sortHeard")}</option></select></div>
      {people.length === 0 && <div className="rounded-xl border border-border bg-surface-2/30 p-7"><h3 className="font-semibold">{t("people.emptyTitle")}</h3><p className="mt-2 max-w-prose text-sm text-muted-foreground">{t("people.emptyBody")}</p></div>}
      {people.length > 0 && shown.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{t("people.noMatches")}</p>}
      <div className="divide-y divide-border rounded-xl border border-border">{shown.map(p => <div key={p.id} className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0"><div className="flex flex-wrap items-baseline gap-x-2"><strong className="truncate text-sm">{p.displayName}</strong>{p.email && <span className="truncate text-xs text-muted-foreground" dir="auto">{p.email}</span>}</div>
          <p className="mt-1 text-xs tabular-nums text-muted-foreground">{t("people.usage", { notes: p.noteCount, segments: p.segmentCount })} · {t("people.lastHeard", { date: date(p.lastHeard) })}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">{p.duplicates.map(d => <span key={d.id} className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">{t("people.duplicate", { name: d.name })}</span>)}{p.usedOnce && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px]">{t("people.usedOnce")}</span>}{!p.hasVoice && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px]">{t("people.noVoice")}</span>}{p.legacyVoice && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px]">{t("people.legacyVoice")}</span>}</div>
        </div><div className="flex flex-wrap gap-1.5">{(["rename", "merge", "delete"] as Kind[]).map(action => <button key={action} type="button" className={button} onClick={() => start(p, action)}>{t(`people.actions.${action}`)}</button>)}{p.hasVoice && <button type="button" className={button} onClick={() => start(p, "reset")}>{t("people.actions.reset")}</button>}</div>
      </div>)}</div>
    </div>}
    {!loading && !error && tab === "review" && <div role="tabpanel" className="space-y-4">
      {reviewLoading && <p role="status" className="text-sm text-muted-foreground">{t("people.loading")}</p>}
      {reviewError && <div role="alert" className="rounded-xl border border-destructive/30 p-4 text-sm">{t("people.loadError")} <button type="button" className={button} onClick={() => setReviewReload(value => value + 1)}>{t("people.retry")}</button></div>}
      <div className="grid gap-2 sm:grid-cols-2"><select className={field} aria-label={t("people.filterReason")} value={reason} onChange={e => { setReason(e.target.value); setLimit(100); }}><option value="">{t("people.allReasons")}</option>{reasons.map(r => <option key={r} value={r}>{filterReasonLabel(r)}</option>)}</select><select className={field} aria-label={t("people.filterPerson")} value={personFilter} onChange={e => { setPersonFilter(e.target.value); setLimit(100); }}><option value="">{t("people.allPeople")}</option>{people.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></div>
      {!reviewLoading && !reviewError && shownReview.length === 0 && <p className="rounded-xl border border-border p-6 text-sm text-muted-foreground">{t("people.reviewEmpty")}</p>}
      <div className="divide-y divide-border rounded-xl border border-border">{shownReview.slice(0, limit).map(r => <div key={`${r.noteId}:${r.rowId}`} className="grid gap-2 p-4 sm:grid-cols-[1fr_auto] sm:items-center"><div className="min-w-0"><p className="text-xs text-muted-foreground">{r.noteTitle} · {reasonLabel(r)}</p><p className="mt-1 line-clamp-2 text-sm">{r.text}</p><p className="mt-1 text-xs text-muted-foreground">{r.speakerName || t("people.unknown")}</p></div><button type="button" className={button} onClick={() => onOpenNote?.(r.noteId, r.rowId)}>{t("people.openRow")}</button></div>)}</div>
      {shownReview.length > limit && <button type="button" className={button} onClick={() => setLimit(limit + 100)}>{t("people.showMore")}</button>}
    </div>}
    {selected && <div className="rounded-xl border border-border bg-surface-2/40 p-5" role="region" aria-label={t("people.previewTitle")}><h3 className="font-semibold">{t("people.previewTitle")} · {t(`people.actions.${kind}`)}</h3><p className="mt-1 text-sm text-muted-foreground">{selected.displayName}</p>
      {kind === "rename" && <label className="mt-4 block text-sm">{t("people.newName")}<input dir="auto" className={`${field} mt-1`} value={name} onChange={e => setName(e.target.value)} maxLength={120} /></label>}
      {kind === "merge" && <label className="mt-4 block text-sm">{t("people.survivor")}<select className={`${field} mt-1`} value={survivorId} onChange={e => setSurvivorId(Number(e.target.value))}><option value={0}>{t("people.choosePerson")}</option>{people.filter(p => p.id !== selected.id).map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label>}
      {previewLoading && <p role="status" className="mt-4 text-sm">{t("people.loadingPreview")}</p>}
      {preview?.success && <p className="mt-4 text-sm">{kind === "reset"
        ? t("people.resetPreview", { samples: preview.voiceSamples, notes: preview.noteCount, segments: preview.segmentCount })
        : t("people.previewCounts", { notes: preview.noteCount, segments: preview.segmentCount, pinned: preview.pinnedCount })} {t(`people.scope.${kind}`)}</p>}
      {preview && !preview.success && <p role="alert" className="mt-4 text-sm text-destructive">{t(`people.errors.${preview.error}`, { defaultValue: t("people.actionError") })}</p>}
      {actionError && <p role="alert" className="mt-4 text-sm text-destructive">{t(`people.errors.${actionError}`, { defaultValue: t("people.actionError") })}</p>}
      <div className="mt-4 flex gap-2"><button type="button" className={button} onClick={() => setSelected(null)}>{t("people.cancel")}</button><button type="button" className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`} disabled={!preview?.success || working} onClick={() => void execute()}>{working ? t("people.working") : t(`people.actions.${kind}`)}</button></div>
    </div>}
    {report && <div role="status" className="rounded-xl border border-border bg-surface-2/40 p-5"><p className="text-sm font-medium">{report.type === "reset" ? t("people.doneReset", { name: report.name }) : t("people.done", { action: t(`people.actions.${report.type}`), name: report.name, notes: report.count, segments: report.segments })}</p><button type="button" className={`${button} mt-3`} disabled={working} onClick={() => void undo()}>{t("people.undo")}</button>{actionError && <p role="alert" className="mt-2 text-sm text-destructive">{t(`people.errors.${actionError}`, { defaultValue: t("people.actionError") })}</p>}</div>}
  </div>;
}
