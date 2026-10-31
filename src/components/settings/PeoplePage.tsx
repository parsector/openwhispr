import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUiLocale } from "../../hooks/useUiLocale";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SectionHeader, SETTINGS_ROW_TITLE_CLASS } from "../ui/SettingsSection";
import { matchesPerson } from "../../utils/personSearch";

type Person = Awaited<ReturnType<NonNullable<typeof window.electronAPI.listPeople>>>[number];
type Review = Awaited<ReturnType<NonNullable<typeof window.electronAPI.listPeopleReview>>>[number];
type Kind = "rename" | "merge" | "delete" | "reset";
type Request = { type: Kind; profileId: number; survivorId?: number; name?: string };
type Preview = { success: boolean; error?: string; noteCount?: number; segmentCount?: number; pinnedCount?: number; voiceSamples?: number; historyCount?: number; noteEmbeddingCount?: number };
type HistoryAction = Awaited<ReturnType<NonNullable<typeof window.electronAPI.listPeopleActions>>>[number];
type EnrollmentCandidate = Awaited<ReturnType<NonNullable<typeof window.electronAPI.listVoiceEnrollmentCandidates>>>[number];
type EnrollmentSample = Awaited<ReturnType<NonNullable<typeof window.electronAPI.listVoiceEnrollmentSamples>>>[number];
const field = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";
const button = "rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export default function PeoplePage({ onOpenNote }: { onOpenNote?: (noteId: number, rowId: string) => void }) {
  const { t } = useTranslation();
  const locale = useUiLocale();
  const [tab, setTab] = useState<"people" | "review">("people");
  const [people, setPeople] = useState<Person[]>([]);
  const [actionHistory, setActionHistory] = useState<HistoryAction[]>([]);
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
  const [clearPreview, setClearPreview] = useState<{ success: boolean; personCount: number; embeddingCount: number; mappingCount: number; noteEmbeddingCount: number } | null>(null);
  const [clearReport, setClearReport] = useState<{ id: string; personCount: number; embeddingCount: number; mappingCount: number } | null>(null);
  const [enrollingId, setEnrollingId] = useState<number | null>(null);
  const [candidates, setCandidates] = useState<EnrollmentCandidate[]>([]);
  const [enrollmentSamples, setEnrollmentSamples] = useState<EnrollmentSample[]>([]);
  const [enrollmentLoading, setEnrollmentLoading] = useState(false);
  const [listeningId, setListeningId] = useState<string | null>(null);
  const [listened, setListened] = useState<{ id: string; token: string } | null>(null);
  const [enrollmentError, setEnrollmentError] = useState("");
  const enrollmentPlayer = useRef<HTMLAudioElement | null>(null);
  const enrollmentUrl = useRef<string | null>(null);
  const enrollmentRequest = useRef(0);
  const previewRef = useRef<HTMLDivElement>(null);
  const enrollmentPanelRef = useRef<HTMLElement>(null);
  const reportRef = useRef<HTMLDivElement>(null);
  const previewTrigger = useRef<HTMLElement | null>(null);
  const enrollmentTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => { if (selected) previewRef.current?.focus(); }, [selected?.id, kind]);
  useEffect(() => { if (enrollingId !== null) enrollmentPanelRef.current?.focus(); }, [enrollingId]);
  useEffect(() => { if (report) reportRef.current?.focus(); }, [report?.id]);
  useEffect(() => () => { enrollmentPlayer.current?.pause(); if (enrollmentUrl.current) URL.revokeObjectURL(enrollmentUrl.current); }, []);
  const openEnrollment = async (profileId: number) => {
    enrollmentTrigger.current = document.activeElement as HTMLElement;
    const request = ++enrollmentRequest.current;
    enrollmentPlayer.current?.pause();
    setEnrollingId(profileId); setListened(null); setListeningId(null);
    setEnrollmentError(""); setCandidates([]); setEnrollmentSamples([]); setEnrollmentLoading(true);
    try {
      const [offers, samples] = await Promise.all([
        window.electronAPI.listVoiceEnrollmentCandidates?.(profileId),
        window.electronAPI.listVoiceEnrollmentSamples?.(profileId),
      ]);
      if (request !== enrollmentRequest.current) return;
      setCandidates(offers || []); setEnrollmentSamples(samples || []);
    }
    catch { if (request === enrollmentRequest.current) setEnrollmentError("unavailable"); }
    finally { if (request === enrollmentRequest.current) setEnrollmentLoading(false); }
  };
  const playCandidate = async (candidate: EnrollmentCandidate) => {
    if (candidate.profileId !== enrollingId) return;
    const request = enrollmentRequest.current;
    enrollmentPlayer.current?.pause();
    if (enrollmentUrl.current) URL.revokeObjectURL(enrollmentUrl.current);
    setListened(null); setListeningId(candidate.id); setEnrollmentError("");
    try {
      const result = await window.electronAPI.playVoiceEnrollmentCandidate?.(candidate.id);
      if (request !== enrollmentRequest.current) return;
      if (!result?.wav || !result.token) throw Error("unavailable");
      const bytes = Uint8Array.from(atob(result.wav), character => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
      enrollmentUrl.current = url;
      const player = new Audio(url);
      enrollmentPlayer.current = player;
      player.onended = () => { if (request === enrollmentRequest.current) {
        void window.electronAPI.completeVoiceEnrollmentCandidate?.(candidate.id, result.token!)
          .then(completed => { if (request === enrollmentRequest.current && completed?.success) {
            setListeningId(null); setListened({ id: candidate.id, token: result.token! });
          } else if (request === enrollmentRequest.current) {
            setListeningId(null); setEnrollmentError("playback_required");
          } }).catch(() => { if (request === enrollmentRequest.current) {
            setListeningId(null); setEnrollmentError("unavailable");
          } });
      } };
      player.onerror = () => { if (request === enrollmentRequest.current) {
        setListeningId(null); setEnrollmentError("unavailable");
      } };
      await player.play();
    } catch { if (request === enrollmentRequest.current) {
      setListeningId(null); setEnrollmentError("unavailable");
    } }
  };
  const decideCandidate = async (candidate: EnrollmentCandidate, choice: "approve" | "reject") => {
    if (listened?.id !== candidate.id || candidate.profileId !== enrollingId) return;
    const request = enrollmentRequest.current;
    setWorking(true); setEnrollmentError("");
    try {
      const result = await window.electronAPI.decideVoiceEnrollmentCandidate?.(candidate.id, choice, listened.token);
      if (!result?.success) throw Error(result?.error || "unavailable");
      if (request !== enrollmentRequest.current) return;
      setListened(null);
      const [offers, samples] = await Promise.all([
        window.electronAPI.listVoiceEnrollmentCandidates?.(candidate.profileId),
        window.electronAPI.listVoiceEnrollmentSamples?.(candidate.profileId),
      ]);
      if (request !== enrollmentRequest.current) return;
      setCandidates(offers || []); setEnrollmentSamples(samples || []);
      await refresh();
    } catch (cause) { if (request === enrollmentRequest.current)
      setEnrollmentError(String(cause instanceof Error ? cause.message : cause)); }
    finally { setWorking(false); }
  };
  const removeEnrollmentSample = async (sample: EnrollmentSample) => {
    if (sample.profileId !== enrollingId) return;
    const request = enrollmentRequest.current;
    setWorking(true); setEnrollmentError("");
    try {
      const result = await window.electronAPI.removeVoiceEnrollmentSample?.(sample.id);
      if (!result?.success) throw Error(result?.error || "unavailable");
      if (request !== enrollmentRequest.current) return;
      const samples = await window.electronAPI.listVoiceEnrollmentSamples?.(sample.profileId);
      if (request !== enrollmentRequest.current) return;
      setEnrollmentSamples(samples || []);
      await refresh();
    } catch (cause) { if (request === enrollmentRequest.current)
      setEnrollmentError(String(cause instanceof Error ? cause.message : cause)); }
    finally { setWorking(false); }
  };
  const refresh = useCallback(async () => {
    setLoading(true); setError(false);
    try {
      if (!window.electronAPI.listPeople) throw Error("unavailable");
      const [people, actions] = await Promise.all([window.electronAPI.listPeople(), window.electronAPI.listPeopleActions?.() || Promise.resolve([])]);
      setPeople(people); setActionHistory(actions);
    } catch { setError(true); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => window.electronAPI.onPeopleChanged?.(() => { void refresh(); }), [refresh]);
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
  const shown = useMemo(() => people.filter(p => matchesPerson(p, query))
    .sort((a, b) => sort === "usage" ? b.noteCount - a.noteCount || b.segmentCount - a.segmentCount || a.displayName.localeCompare(b.displayName)
      : (b.lastSeen || "").localeCompare(a.lastSeen || "") || a.displayName.localeCompare(b.displayName)), [people, query, sort]);
  const reasons = useMemo(() => [...new Set(review.map(r => r.reason).filter(r => r !== "person"))].sort(), [review]);
  const shownReview = useMemo(() => review.filter(r => (personFilter || r.reason !== "person") && (!reason || r.reason === reason) && (!personFilter || String(r.profileId) === personFilter)), [review, reason, personFilter]);
  const reasonLabel = (row: Review) => row.reason === "person" ? t("people.reasons.person")
    : row.reason === "unassessed" ? t("notes.speaker.notAssessed")
    : row.reason === "close_match" && row.candidates ? t("notes.speaker.reason.closeMatch", { first: row.candidates[0], second: row.candidates[1] })
    : t(`notes.speaker.reason.${row.reason}`, { defaultValue: t("people.reasons.uncertain") });
  const filterReasonLabel = (value: string) => value === "close_match" ? t("people.reasons.close_match") : reasonLabel({ reason: value, candidates: null } as Review);
  const actionErrorText = (value: string) => value === "history_quarantined" ? t("notes.speaker.historyQuarantined")
    : t(`people.errors.${value}`, { defaultValue: t("people.actionError") });
  const start = (person: Person, action: Kind) => { previewTrigger.current = document.activeElement as HTMLElement; setSelected(person); setKind(action); setName(person.displayName); setSurvivorId(0); setActionError(""); setReport(null); };
  const closePreview = () => { setSelected(null); requestAnimationFrame(() => previewTrigger.current?.focus()); };
  const closeEnrollment = () => { enrollmentRequest.current++; enrollmentPlayer.current?.pause(); setEnrollingId(null); setListened(null); setCandidates([]); setEnrollmentSamples([]); requestAnimationFrame(() => enrollmentTrigger.current?.focus()); };
  const newestActionIndex = actionHistory.findIndex(item => !item.unavailableReason);
  const execute = async () => {
    if (!request || !preview?.success || working) return;
    setWorking(true); setActionError("");
    try {
      const result = await window.electronAPI.applyPersonAction?.({ ...request, expected: {
        noteCount: preview.noteCount || 0, segmentCount: preview.segmentCount || 0,
        pinnedCount: preview.pinnedCount || 0, historyCount: preview.historyCount || 0,
        noteEmbeddingCount: preview.noteEmbeddingCount || 0,
      } });
      if (!result?.success || (kind !== "delete" && !result.id)) throw Error(result?.error || "persistence_failed");
      setReport({ id: result.id || "", name: selected!.displayName, type: kind, count: result.noteCount || 0, segments: result.segmentCount || 0 });
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
  const previewClear = async () => {
    setActionError(""); setClearPreview(null);
    try {
      const result = await window.electronAPI.previewClearVoiceData?.();
      if (!result?.success) throw Error("persistence_failed");
      setClearPreview(result);
    }
    catch { setActionError("persistence_failed"); }
  };
  const applyClear = async () => {
    if (!clearPreview || working) return;
    setWorking(true); setActionError("");
    try {
      const result = await window.electronAPI.clearVoiceData?.(clearPreview);
      if (!result?.success || !result.id) throw Error(result?.error || "persistence_failed");
      setClearReport({ id: result.id, personCount: result.personCount || 0, embeddingCount: result.embeddingCount || 0, mappingCount: result.mappingCount || 0 });
      setClearPreview(null); await refresh();
    } catch (cause) { setActionError(String(cause instanceof Error ? cause.message : cause)); }
    finally { setWorking(false); }
  };
  const undoClear = async () => {
    if (!clearReport || working) return;
    setWorking(true); setActionError("");
    try {
      const result = await window.electronAPI.undoClearVoiceData?.(clearReport.id);
      if (!result?.success) throw Error(result?.error || "persistence_failed");
      setClearReport(null); await refresh();
    } catch (cause) { setActionError(String(cause instanceof Error ? cause.message : cause)); }
    finally { setWorking(false); }
  };
  const undoHistory = async (action: HistoryAction) => {
    if (working) return;
    setWorking(true); setActionError("");
    try {
      const result = action.kind === "clear_voice" ? await window.electronAPI.undoClearVoiceData?.(action.id)
        : action.kind === "enrollment" ? await window.electronAPI.undoVoiceEnrollmentAction?.(action.id)
        : (["apply", "correction", "split", "reconsideration"].includes(action.kind)) && action.noteId
          ? await window.electronAPI.applySpeakerCorrection?.({ type: "undo", noteId: action.noteId, id: action.id })
        : action.kind === "mapping" && action.noteId ? await window.electronAPI.undoPeopleMapping?.(action.noteId)
        : action.kind === "adoption" && action.noteId ? await window.electronAPI.takeCloudSpeakerLabels?.(action.noteId, true)
        : await window.electronAPI.undoPersonAction?.(action.id);
      if (!result?.success) throw Error(result?.error || "persistence_failed");
      setReport(null); setClearReport(null); await refresh();
    } catch (cause) { setActionError(String(cause instanceof Error ? cause.message : cause)); }
    finally { setWorking(false); }
  };
  const date = (value: string | null) => value ? new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" }) : t("people.never");
  return <div className="space-y-5 pb-8 text-foreground">
    <SectionHeader title={t("people.title")} description={t("people.subtitle")} />
    <div role="tablist" aria-label={t("people.title")} className="flex gap-1 border-b border-border">
      {(["people", "review"] as const).map(item => <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => setTab(item)} className={`px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${tab === item ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`}>{t(`people.tabs.${item}`)}</button>)}
    </div>
    {loading && <div role="status" className="space-y-2" aria-label={t("people.loading")}>{[0, 1, 2].map(i => <div key={i} className="h-16 animate-pulse rounded-lg bg-surface-2" />)}<p className="text-sm text-muted-foreground">{t("people.loading")}</p></div>}
    {error && !loading && <div role="alert" className="rounded-xl border border-destructive/30 p-5"><p className="font-medium">{t("people.loadError")}</p><button type="button" className={`${button} mt-3`} onClick={() => void refresh()}>{t("people.retry")}</button></div>}
    {!loading && !error && tab === "people" && <div role="tabpanel" className="space-y-4">
      <section className="rounded-xl border border-border p-4" aria-label={t("people.actionHistory")}>
        <SectionHeader title={t("people.actionHistory")} />
        {actionHistory.length === 0 && <p className="mt-2 text-xs text-muted-foreground">{t("people.noActions")}</p>}
        <ol className="mt-2 space-y-2">{actionHistory.map((action, index) => <li key={`${action.id}:${action.noteId}`} className="flex items-center justify-between gap-3 text-xs">
          <span className="min-w-0 break-words">{action.kind === "clear_voice" ? t("people.clearVoice") : ["apply", "correction"].includes(action.kind) ? t("people.correctionAction") : action.kind === "split" ? t("notes.speaker.splitCluster") : action.kind === "enrollment" ? t(action.label.startsWith("approve:") ? "people.approveSample" : action.label.startsWith("reject:") ? "people.rejectSample" : "people.removeSample") : action.kind === "reconsideration" ? t("notes.speaker.reason.approved_voice") : action.kind === "mapping" ? t("people.mappingAction") : action.kind === "adoption" ? t("people.adoptionAction") : t(`people.actions.${action.kind}`)}{["rename", "merge", "delete", "reset", "apply", "correction", "mapping", "adoption"].includes(action.kind) && <> · {action.label === "deleted_person" ? t("people.deletedPerson") : action.label === "Unknown" ? t("people.unknown") : action.label}</>}{action.noteInTrash ? ` · ${t("people.noteInTrash")}` : ""}</span>
          {action.unavailableReason ? <span className="text-muted-foreground">{actionErrorText(action.unavailableReason)}</span>
            : index !== newestActionIndex ? <span className="text-muted-foreground">{t("people.errors.later_change")}</span>
            : <button type="button" className={button} disabled={working} onClick={() => void undoHistory(action)}>{t("people.undo")}</button>}
        </li>)}</ol>
      </section>
      <div className="rounded-xl border border-border p-4"><button type="button" className={button} onClick={() => void previewClear()}>{t("people.clearVoice")}</button>
        {clearPreview && <div role="region" aria-label={t("people.clearVoice")} className="mt-3 text-sm"><p>{t("people.clearPreview", { people: clearPreview.personCount, embeddings: clearPreview.embeddingCount + clearPreview.noteEmbeddingCount, mappings: clearPreview.mappingCount })}</p><div className="mt-3 flex gap-2"><button type="button" className={button} onClick={() => setClearPreview(null)}>{t("people.cancel")}</button><button type="button" className={button} disabled={working} onClick={() => void applyClear()}>{working ? t("people.working") : t("people.clearVoice")}</button></div></div>}
        {clearReport && <div role="status" className="mt-3 text-sm"><p>{t("people.clearDone", { people: clearReport.personCount, embeddings: clearReport.embeddingCount, mappings: clearReport.mappingCount })}</p>{actionHistory.find(item => !item.unavailableReason)?.id === clearReport.id ? <button type="button" className={`${button} mt-2`} disabled={working} onClick={() => void undoClear()}>{t("people.undo")}</button> : <p className="mt-2 text-muted-foreground">{t("people.errors.later_change")}</p>}</div>}
        {actionError && !selected && !report && <p role="alert" className="mt-2 text-sm text-destructive">{actionErrorText(actionError)}</p>}
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]"><input dir="auto" className={field} aria-label={t("people.search")} placeholder={t("people.search")} value={query} onChange={e => setQuery(e.target.value)} /><Select value={sort} onValueChange={value => setSort(value as typeof sort)}><SelectTrigger aria-label={t("people.sort")} className="w-auto"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="usage">{t("people.sortUsage")}</SelectItem><SelectItem value="heard">{t("people.sortHeard")}</SelectItem></SelectContent></Select></div>
      {people.length === 0 && <div className="rounded-xl border border-border bg-surface-2/30 p-7"><SectionHeader title={t("people.emptyTitle")} /><p className="max-w-prose text-xs text-muted-foreground">{t("people.emptyBody")}</p></div>}
      {people.length > 0 && shown.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{t("people.noMatches")}</p>}
      <div className="divide-y divide-border rounded-xl border border-border">{shown.map(p => <div key={p.id} className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0"><div className="flex flex-wrap items-baseline gap-x-2"><strong className={`min-w-0 break-words [overflow-wrap:anywhere] ${SETTINGS_ROW_TITLE_CLASS}`}>{p.displayName}</strong>{p.email && <span className="min-w-0 break-all text-xs text-muted-foreground" dir="auto">{p.email}</span>}</div>
          <p className="mt-1 text-xs tabular-nums text-muted-foreground">{t("people.meetingCount", { count: p.meetingCount })}{p.segmentCount > 0 && <> · {t("people.usage", { notes: p.noteCount, segments: p.segmentCount })}</>}{p.lastSeen && <> · {t("people.lastSeen", { date: date(p.lastSeen) })}</>}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">{p.duplicates.map(d => <span key={d.id} className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] text-foreground">{t("people.duplicate", { name: d.name })}</span>)}{p.hasVoice && p.needsReapproval && <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] text-foreground">{t("meetingAudio.reapproval")}</span>}{p.segmentCount > 0 && p.usedOnce && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px]">{t("people.usedOnce")}</span>}{p.legacyVoice && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px]">{t("people.legacyVoice")}</span>}</div>
          {(p.hasVoice || p.voiceProgress.cleanSpans > 0) && <p className="mt-2 text-xs tabular-nums text-muted-foreground">{t("people.enrollmentProgress", { spans: p.voiceProgress.cleanSpans, meetings: p.voiceProgress.meetings })} · {t(p.voiceProgress.usable ? "people.voiceUsable" : "people.voiceProvisional")}</p>}
          {p.voiceProgress.conflict && <p role="alert" className="mt-2 text-xs text-foreground">{t("people.voiceConflict")}</p>}
        </div><div className="flex flex-wrap gap-1.5">{(["rename", "merge", "delete"] as Kind[]).map(action => <button key={action} type="button" className={button} onClick={() => start(p, action)}>{t(`people.actions.${action}`)}</button>)}<button type="button" className={button} onClick={() => void openEnrollment(p.id)}>{t("people.enrollVoice")}</button>{p.hasVoice && <button type="button" className={button} onClick={() => start(p, "reset")}>{t("people.actions.reset")}</button>}</div>
      </div>)}</div>
      {enrollingId !== null && <section ref={enrollmentPanelRef} tabIndex={-1} className="rounded-xl border border-border bg-surface-2/40 p-5 outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("people.enrollVoice")}>
        <div className="flex items-center justify-between gap-3"><SectionHeader title={`${t("people.enrollVoice")} · ${people.find(p => p.id === enrollingId)?.displayName || ""}`} /><button type="button" className={button} onClick={closeEnrollment}>{t("people.cancel")}</button></div>
        <p className="mt-2 text-sm text-muted-foreground">{t("people.enrollmentIntro")}</p>
        {enrollmentError && <p role="alert" className="mt-3 text-sm text-destructive">{t(`people.enrollmentErrors.${enrollmentError}`, { defaultValue: t("people.actionError") })}</p>}
        {enrollmentLoading && <p role="status" className="mt-3 text-sm text-muted-foreground">{t("people.loading")}</p>}
        {!enrollmentLoading && candidates.length === 0 && <p className="mt-3 text-sm text-muted-foreground">{t("people.noEnrollmentCandidates")}</p>}
        <div className="mt-3 divide-y divide-border rounded-lg border border-border">{candidates.map(candidate => <div key={candidate.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
          <div><p className="text-sm font-medium">{candidate.noteTitle}</p><p className="text-xs text-muted-foreground">{date(candidate.meetingDate)} · {t("people.enrollmentDuration", { seconds: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(candidate.durationSeconds) })} · {t("people.neverCorrected")}</p></div>
          <div className="flex gap-2"><button type="button" className={button} disabled={listeningId !== null || working} onClick={() => void playCandidate(candidate)}>{listeningId === candidate.id ? t("people.playing") : t("people.listen")}</button><button type="button" className={button} disabled={working || listened?.id !== candidate.id} onClick={() => void decideCandidate(candidate, "approve")}>{t("people.approveSample")}</button><button type="button" className={button} disabled={working || listened?.id !== candidate.id} onClick={() => void decideCandidate(candidate, "reject")}>{t("people.rejectSample")}</button></div>
        </div>)}</div>
        {enrollmentSamples.length > 0 && <div className="mt-4"><SectionHeader title={t("people.approvedSamples")} /><div className="divide-y divide-border rounded-lg border border-border">{enrollmentSamples.map(sample => <div key={sample.id} className={`flex flex-wrap items-center justify-between gap-3 p-3 ${sample.odd ? "bg-warning/10" : ""}`}><span className="text-sm">{sample.noteTitle} · {date(sample.meetingDate)}{sample.odd && <> · {t("people.oddSample")}</>}</span><div className="flex gap-2">{sample.odd && <button type="button" className={button} disabled={!onOpenNote} onClick={() => onOpenNote?.(sample.noteId, sample.rowIds[0])}>{t("people.splitSample")}</button>}<button type="button" className={button} disabled={working} onClick={() => void removeEnrollmentSample(sample)}>{t("people.removeSample")}</button></div></div>)}</div></div>}
      </section>}
    </div>}
    {!loading && !error && tab === "review" && <div role="tabpanel" className="space-y-4">
      {reviewLoading && <p role="status" className="text-sm text-muted-foreground">{t("people.loading")}</p>}
      {reviewError && <div role="alert" className="rounded-xl border border-destructive/30 p-4 text-sm">{t("people.loadError")} <button type="button" className={button} onClick={() => setReviewReload(value => value + 1)}>{t("people.retry")}</button></div>}
      <div className="grid gap-2 sm:grid-cols-2"><Select value={reason || "__all__"} onValueChange={value => { setReason(value === "__all__" ? "" : value); setLimit(100); }}><SelectTrigger aria-label={t("people.filterReason")}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__all__">{t("people.allReasons")}</SelectItem>{reasons.map(r => <SelectItem key={r} value={r}>{filterReasonLabel(r)}</SelectItem>)}</SelectContent></Select><Select value={personFilter || "__all__"} onValueChange={value => { setPersonFilter(value === "__all__" ? "" : value); setLimit(100); }}><SelectTrigger aria-label={t("people.filterPerson")}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__all__">{t("people.allPeople")}</SelectItem>{people.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.displayName}</SelectItem>)}</SelectContent></Select></div>
      {!reviewLoading && !reviewError && shownReview.length === 0 && <p className="rounded-xl border border-border p-6 text-sm text-muted-foreground">{t("people.reviewEmpty")}</p>}
      <div className="divide-y divide-border rounded-xl border border-border">{shownReview.slice(0, limit).map(r => <div key={`${r.noteId}:${r.rowId}`} className="grid gap-2 p-4 sm:grid-cols-[1fr_auto] sm:items-center"><div className="min-w-0"><p className="text-xs text-muted-foreground">{r.noteTitle} · {reasonLabel(r)}</p><p className="mt-1 line-clamp-2 text-sm">{r.text}</p><p className="mt-1 text-xs text-muted-foreground">{r.speakerName || t("people.unknown")}</p></div><button type="button" className={button} disabled={!onOpenNote} onClick={() => onOpenNote?.(r.noteId, r.rowId)}>{t("people.openRow")}</button></div>)}</div>
      {shownReview.length > limit && <button type="button" className={button} onClick={() => setLimit(limit + 100)}>{t("people.showMore")}</button>}
    </div>}
    {selected && <div ref={previewRef} tabIndex={-1} className="rounded-xl border border-border bg-surface-2/40 p-5 outline-none focus-visible:ring-2 focus-visible:ring-ring" role="region" aria-label={t("people.previewTitle")}><SectionHeader title={`${t("people.previewTitle")} · ${t(`people.actions.${kind}`)}`} /><p className="text-xs text-muted-foreground">{selected.displayName}</p>
      {kind === "rename" && <label className="mt-4 block text-sm">{t("people.newName")}<input dir="auto" className={`${field} mt-1`} value={name} onChange={e => setName(e.target.value)} maxLength={120} /></label>}
      {kind === "merge" && <div className="mt-4 text-sm"><label id="people-survivor-label">{t("people.survivor")}</label><Select value={survivorId ? String(survivorId) : "__choose__"} onValueChange={value => setSurvivorId(value === "__choose__" ? 0 : Number(value))}><SelectTrigger aria-labelledby="people-survivor-label" className="mt-1"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__choose__">{t("people.choosePerson")}</SelectItem>{people.filter(p => p.id !== selected.id).map(p => <SelectItem key={p.id} value={String(p.id)}>{p.displayName}</SelectItem>)}</SelectContent></Select></div>}
      {previewLoading && <p role="status" className="mt-4 text-sm">{t("people.loadingPreview")}</p>}
      {preview?.success && <p className="mt-4 text-sm">{kind === "delete"
        ? <>{t("people.deletePreview", { notes: preview.noteCount, segments: preview.segmentCount, history: preview.historyCount })}{selected.meetingCount > 0 && selected.segmentCount === 0 && !selected.hasVoice && <> {t("people.attendeeDeleteReappears")}</>}</>
        : kind === "reset"
        ? t("people.resetPreview", { samples: preview.voiceSamples, notes: preview.noteCount, segments: preview.segmentCount })
        : t("people.previewCounts", { notes: preview.noteCount, segments: preview.segmentCount, pinned: preview.pinnedCount })} {['delete', 'reset'].includes(kind) && t("people.noteVoiceEvidence", { count: preview.noteEmbeddingCount || 0 })} {t(`people.scope.${kind}`)}</p>}
      {preview && !preview.success && <p role="alert" className="mt-4 text-sm text-destructive">{t(`people.errors.${preview.error}`, { defaultValue: t("people.actionError") })}</p>}
      {actionError && <p role="alert" className="mt-4 text-sm text-destructive">{actionErrorText(actionError)}</p>}
      <div className="mt-4 flex gap-2"><button type="button" className={button} onClick={closePreview}>{t("people.cancel")}</button><button type="button" className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`} disabled={!preview?.success || working} onClick={() => void execute()}>{working ? t("people.working") : t(`people.actions.${kind}`)}</button></div>
    </div>}
    {report && <div ref={reportRef} tabIndex={-1} role="status" className="rounded-xl border border-border bg-surface-2/40 p-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"><p className="text-sm font-medium">{report.type === "reset" ? t("people.doneReset", { name: report.name }) : t("people.done", { action: t(`people.actions.${report.type}`), name: report.name, notes: report.count, segments: report.segments })}</p>{report.type !== "delete" && (actionHistory.find(item => !item.unavailableReason)?.id === report.id ? <button type="button" className={`${button} mt-3`} disabled={working} onClick={() => void undo()}>{t("people.undo")}</button> : <p className="mt-2 text-sm text-muted-foreground">{t("people.errors.later_change")}</p>)}{actionError && <p role="alert" className="mt-2 text-sm text-destructive">{actionErrorText(actionError)}</p>}</div>}
  </div>;
}
