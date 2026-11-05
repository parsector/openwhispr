import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FocusScope } from "@radix-ui/react-focus-scope";
import { useTranslation } from "react-i18next";
import { useUiLocale } from "../../hooks/useUiLocale";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SectionHeader } from "../ui/SettingsSection";
import { ProviderTabs } from "../ui/ProviderTabs";
import { useSubTab } from "../../hooks/useSubTab";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { ClipboardCheck, Clock, MoreHorizontal, Pencil, Settings2, Users } from "../icons";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Progress } from "../ui/progress";
import EmptyStateCard from "../ui/EmptyStateCard";
import { Skeleton } from "../ui/skeleton";
import { useToast } from "../ui/useToast";
import { matchesPerson } from "../../utils/personSearch";
import { saveEnrollmentDecision } from "./enrollmentDecision";
import { SpeakerCalibrationReport } from "./SpeakerCalibrationReport";

type Person = Awaited<ReturnType<NonNullable<typeof window.electronAPI.listPeople>>>[number];
type Review = Awaited<ReturnType<NonNullable<typeof window.electronAPI.listPeopleReview>>>[number];
type Kind = "rename" | "merge" | "delete" | "reset";
type Request = { type: Kind; profileId: number; survivorId?: number; name?: string };
type Preview = {
  success: boolean;
  error?: string;
  noteCount?: number;
  segmentCount?: number;
  pinnedCount?: number;
  voiceSamples?: number;
  historyCount?: number;
  noteEmbeddingCount?: number;
};
type HistoryAction = Awaited<
  ReturnType<NonNullable<typeof window.electronAPI.listPeopleActions>>
>[number];
type EnrollmentCandidate = Awaited<
  ReturnType<NonNullable<typeof window.electronAPI.listVoiceEnrollmentCandidates>>
>["candidates"][number];
type EnrollmentReasons = Awaited<
  ReturnType<NonNullable<typeof window.electronAPI.listVoiceEnrollmentCandidates>>
>["reasons"];
type EnrollmentSample = Awaited<
  ReturnType<NonNullable<typeof window.electronAPI.listVoiceEnrollmentSamples>>
>[number];
type CalibrationProgress = Awaited<
  ReturnType<NonNullable<typeof window.electronAPI.speakerCalibrationProgress>>
>;
type CalibrationReport = NonNullable<NonNullable<CalibrationProgress>["report"]>;
type CalibrationValues = {
  similarityFloor: number;
  runnerUpMargin: number;
  minimumVoicedSeconds: number;
  overlapToleranceSeconds: number;
};
const calibrationFields: Array<keyof CalibrationValues> = [
  "similarityFloor",
  "runnerUpMargin",
  "minimumVoicedSeconds",
  "overlapToleranceSeconds",
];
const reviewReturnKey = "peopleReviewReturn";
const reviewEligibleKey = "peopleReviewEligibleOnly";
const peopleReturnKey = "peopleListReturn";
const PEOPLE_TABS = ["people", "history", "voice"] as const;
type PeopleTab = (typeof PEOPLE_TABS)[number];
type ReviewReturn = { reason: string; personFilter: string; limit: number; scrollTop: number };
type PeopleReturn = { query: string; sort: "usage" | "heard"; windowY: number; hostY: number };
const savedPeopleReturn = (): PeopleReturn | null => {
  try {
    return JSON.parse(window.sessionStorage.getItem(peopleReturnKey) || "null");
  } catch {
    return null;
  }
};
const savedReviewReturn = (): ReviewReturn | null => {
  try {
    return JSON.parse(window.sessionStorage.getItem(reviewReturnKey) || "null");
  } catch {
    return null;
  }
};

export default function PeoplePage({
  onOpenNote,
}: {
  onOpenNote?: (noteId: number, rowId: string) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const locale = useUiLocale();
  const [view, setView] = useSubTab<PeopleTab>("settings.peopleTab", PEOPLE_TABS);
  const reviewReturn = useRef(savedReviewReturn());
  const peopleReturn = useRef(savedPeopleReturn());
  const reviewScroll = useRef<HTMLDivElement>(null);
  const reviewFocus = useRef<{ element: HTMLButtonElement; key: string; index: number } | null>(
    null
  );
  const [reviewOpen, setReviewOpen] = useState(!!reviewReturn.current);
  const rootRef = useRef<HTMLDivElement>(null);
  const reviewTrigger = useRef<HTMLButtonElement>(null);
  const peopleScroll = useRef({ windowY: 0, hostY: 0 });
  const selectPage = (next: PeopleTab) => {
    if (next === view) return;
    const host = rootRef.current?.closest(".overflow-y-auto");
    if (view === "people") {
      peopleScroll.current = { windowY: window.scrollY, hostY: host?.scrollTop || 0 };
    }
    setView(next);
    requestAnimationFrame(() => {
      window.scrollTo(0, next === "people" ? peopleScroll.current.windowY : 0);
      if (host) host.scrollTop = next === "people" ? peopleScroll.current.hostY : 0;
    });
  };
  const [people, setPeople] = useState<Person[]>([]);
  const [actionHistory, setActionHistory] = useState<HistoryAction[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [calibration, setCalibration] = useState<{
    values: CalibrationValues;
    status: string;
    statuses?: Record<string, string>;
  } | null>(null);
  const [calibrationReport, setCalibrationReport] = useState<CalibrationReport>();
  const [calibrationError, setCalibrationError] = useState("");
  const [calibrationScope, setCalibrationScope] = useState<"all" | "range">("all");
  const [calibrationFrom, setCalibrationFrom] = useState("");
  const [calibrationTo, setCalibrationTo] = useState("");
  const [calibrationNotes, setCalibrationNotes] = useState(12);
  const [calibrationRows, setCalibrationRows] = useState(400);
  const [calibrationJob, setCalibrationJob] = useState<{
    state: string;
    progress: {
      totalRows: number;
      processedRows: number;
      reembeddedRows: number;
      bytesRead: number;
      elapsedMs: number;
    };
  } | null>(null);
  const [calibrationUndoId, setCalibrationUndoId] = useState<string | null>(null);
  const [review, setReview] = useState<Review[]>([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewProgress, setReviewProgress] = useState<{ current: number; total: number } | null>(
    null
  );
  const [reviewLoaded, setReviewLoaded] = useState(false);
  const [reviewError, setReviewError] = useState(false);
  const [reviewReload, setReviewReload] = useState(0);
  const [eligibleOnly, setEligibleOnly] = useState(() => {
    try {
      return window.localStorage.getItem(reviewEligibleKey) !== "false";
    } catch {
      return true;
    }
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState(peopleReturn.current?.query || "");
  const [sort, setSort] = useState<"usage" | "heard">(peopleReturn.current?.sort || "usage");
  const [reason, setReason] = useState(reviewReturn.current?.reason || "");
  const [personFilter, setPersonFilter] = useState(reviewReturn.current?.personFilter || "");
  const [limit, setLimit] = useState(reviewReturn.current?.limit || 100);
  const [selected, setSelected] = useState<Person | null>(null);
  const [kind, setKind] = useState<Kind>("rename");
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renameWorking, setRenameWorking] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const actionCancel = useRef<HTMLButtonElement>(null);
  const survivorTrigger = useRef<HTMLButtonElement>(null);
  const [survivorId, setSurvivorId] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState("");
  const [clearPreview, setClearPreview] = useState<{
    success: boolean;
    personCount: number;
    embeddingCount: number;
    mappingCount: number;
    noteEmbeddingCount: number;
    sampleCount: number;
    candidateCount: number;
  } | null>(null);
  const [clearPreviewLoading, setClearPreviewLoading] = useState(false);
  const [clearConfirmation, setClearConfirmation] = useState("");
  const clearTrigger = useRef<HTMLButtonElement>(null);
  const clearInput = useRef<HTMLInputElement>(null);
  const [clearReport, setClearReport] = useState<{
    id: string;
    personCount: number;
    embeddingCount: number;
    mappingCount: number;
  } | null>(null);
  const [enrollingId, setEnrollingId] = useState<number | null>(null);
  const [candidates, setCandidates] = useState<EnrollmentCandidate[]>([]);
  const [enrollmentReasons, setEnrollmentReasons] = useState<EnrollmentReasons>({
    short: 0,
    long: 0,
    audio: 0,
    overlap: 0,
    uncertain: 0,
    reviewed: 0,
    limit: 0,
    resolution: 0,
  });
  const [enrollmentSamples, setEnrollmentSamples] = useState<EnrollmentSample[]>([]);
  const [enrollmentLoading, setEnrollmentLoading] = useState(false);
  const [listeningId, setListeningId] = useState<string | null>(null);
  const [listened, setListened] = useState<{ id: string; token: string; expiresAt: number } | null>(
    null
  );
  const [listeningNow, setListeningNow] = useState(() => Date.now());
  const [enrollmentError, setEnrollmentError] = useState("");
  const enrollmentPlayer = useRef<HTMLAudioElement | null>(null);
  const enrollmentUrl = useRef<string | null>(null);
  const enrollmentRequest = useRef(0);
  const enrollmentCancelRef = useRef<HTMLButtonElement>(null);
  const enrollmentFromMenu = useRef(false);
  useEffect(() => {
    if (!listened) return;
    const timer = window.setInterval(() => setListeningNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [listened]);
  const listeningSeconds = listened
    ? Math.max(0, Math.ceil((listened.expiresAt - listeningNow) / 1000))
    : 0;
  useEffect(() => {
    if (listened && listeningSeconds === 0 && !working) {
      setListened(null);
      setEnrollmentError("playback_required");
    }
  }, [listened, listeningSeconds, working]);
  const savePeopleReturn = () => {
    const host = rootRef.current?.closest(".overflow-y-auto");
    window.sessionStorage.setItem(
      peopleReturnKey,
      JSON.stringify({
        query,
        sort,
        windowY: window.scrollY,
        hostY: host?.scrollTop || 0,
      } satisfies PeopleReturn)
    );
  };
  useEffect(() => {
    if (loading || !peopleReturn.current) return;
    const saved = peopleReturn.current;
    const frame = requestAnimationFrame(() => {
      window.scrollTo(0, saved.windowY);
      const host = rootRef.current?.closest(".overflow-y-auto");
      if (host) host.scrollTop = saved.hostY;
      peopleReturn.current = null;
      window.sessionStorage.removeItem(peopleReturnKey);
    });
    return () => cancelAnimationFrame(frame);
  }, [loading]);
  useEffect(() => {
    if (
      !reviewOpen ||
      loading ||
      reviewLoading ||
      reviewError ||
      !reviewLoaded ||
      !reviewReturn.current
    )
      return;
    const saved = reviewReturn.current;
    const frame = requestAnimationFrame(() => {
      if (reviewScroll.current) reviewScroll.current.scrollTop = saved.scrollTop;
      reviewReturn.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [reviewOpen, loading, reviewLoading, reviewError, reviewLoaded]);
  useLayoutEffect(() => {
    // A refreshed page can remove the focused cached row before the browser paints.
    const previous = reviewFocus.current;
    reviewFocus.current = null;
    if (!previous || !reviewOpen || !reviewScroll.current) return;
    if (previous.element.isConnected && document.activeElement === previous.element) return;
    if (document.activeElement !== document.body && document.activeElement !== previous.element)
      return;
    const buttons = [
      ...reviewScroll.current.querySelectorAll<HTMLButtonElement>("[data-review-row-key]"),
    ];
    const target =
      buttons.find((button) => button.dataset.reviewRowKey === previous.key) ||
      buttons[Math.min(previous.index, buttons.length - 1)] ||
      reviewScroll.current.querySelector<HTMLButtonElement>('button[role="combobox"]');
    target?.focus({ preventScroll: true });
  }, [review, reviewOpen]);
  useEffect(() => {
    if (!selected) return;
    const target = kind === "merge" ? survivorTrigger.current : actionCancel.current;
    target?.focus({ preventScroll: true });
  }, [selected, kind]);
  useEffect(() => {
    if (editingId !== null) {
      renameInput.current?.focus({ preventScroll: true });
      renameInput.current?.select();
    }
  }, [editingId]);
  useEffect(() => {
    if (enrollingId !== null) enrollmentCancelRef.current?.focus({ preventScroll: true });
  }, [enrollingId]);
  useEffect(
    () => () => {
      enrollmentPlayer.current?.pause();
      if (enrollmentUrl.current) URL.revokeObjectURL(enrollmentUrl.current);
    },
    []
  );
  useEffect(() => {
    if (view !== "voice") return;
    void window.electronAPI
      .speakerCalibrationSettings?.()
      .then((result) => {
        setCalibration(result);
      })
      .catch(() => setCalibrationError(t("people.calibrationUnavailable")));
    void window.electronAPI
      .speakerCalibrationProgress?.()
      .then((job) => {
        if (!job) return;
        setCalibrationJob({ state: job.state, progress: job.progress });
        if (job.report) setCalibrationReport(job.report);
        if (job.error) setCalibrationError(job.error);
      })
      .catch(() => setCalibrationError(t("people.calibrationUnavailable")));
  }, [t, view]);
  useEffect(() => {
    if (calibrationJob?.state !== "running") return;
    const timer = window.setInterval(() => {
      void window.electronAPI
        .speakerCalibrationProgress?.()
        .then((job) => {
          if (!job) return;
          setCalibrationJob({ state: job.state, progress: job.progress });
          if (job.report) setCalibrationReport(job.report);
          if (job.error) setCalibrationError(job.error);
        })
        .catch(() => setCalibrationError(t("people.calibrationUnavailable")));
    }, 400);
    return () => window.clearInterval(timer);
  }, [calibrationJob?.state, t]);
  const startCalibration = async () => {
    setCalibrationReport(undefined);
    setCalibrationError("");
    const result = await window.electronAPI.startSpeakerCalibration?.(
      {
        kind: calibrationScope,
        ...(calibrationScope === "range" ? { from: calibrationFrom, to: calibrationTo } : {}),
      },
      { notes: calibrationNotes, rows: calibrationRows }
    );
    if (!result?.success) {
      setCalibrationError(result?.error || t("people.calibrationUnavailable"));
      return;
    }
    setCalibrationJob({
      state: "running",
      progress: { totalRows: 0, processedRows: 0, reembeddedRows: 0, bytesRead: 0, elapsedMs: 0 },
    });
  };
  const applyCalibration = async () => {
    if (calibrationReport?.resultType !== "supported_recommendation") return;
    const values = {
      ...calibration?.values,
      ...calibrationReport.recommended,
    } as CalibrationValues;
    const result = await window.electronAPI.applySpeakerCalibration?.(values, calibrationReport);
    if (!result?.success || !result.values) {
      setCalibrationError(result?.error || t("people.calibrationUnavailable"));
      return;
    }
    setCalibration({
      values: result.values,
      status: result.status || "uncalibrated",
      statuses: result.statuses,
    });
    setCalibrationUndoId(result.id || null);
    await refresh();
    setCalibrationReport(undefined);
    setCalibrationError("");
  };
  const undoCalibration = async () => {
    if (!calibrationUndoId) return;
    const result = await window.electronAPI.undoSpeakerCalibration?.(calibrationUndoId);
    if (!result?.success || !result.values) {
      setCalibrationError(result?.error || t("people.calibrationUnavailable"));
      return;
    }
    setCalibration({
      values: result.values,
      status: result.status || "uncalibrated",
      statuses: result.statuses,
    });
    setCalibrationUndoId(null);
    await refresh();
  };
  const openEnrollment = useCallback(
    async (profileId: number, fromMenu = false) => {
      if (working || renameWorking) return;
      setSelected(null);
      setEditingId(null);
      enrollmentFromMenu.current = fromMenu;
      const request = ++enrollmentRequest.current;
      enrollmentPlayer.current?.pause();
      setEnrollingId(profileId);
      setListened(null);
      setListeningId(null);
      setEnrollmentError("");
      setCandidates([]);
      setEnrollmentSamples([]);
      setEnrollmentLoading(true);
      try {
        const [offers, samples] = await Promise.all([
          window.electronAPI.listVoiceEnrollmentCandidates?.(profileId),
          window.electronAPI.listVoiceEnrollmentSamples?.(profileId),
        ]);
        if (request !== enrollmentRequest.current) return;
        setCandidates(offers?.candidates || []);
        setEnrollmentReasons(
          offers?.reasons || {
            short: 0,
            long: 0,
            audio: 0,
            overlap: 0,
            uncertain: 0,
            reviewed: 0,
            limit: 0,
            resolution: 0,
          }
        );
        setEnrollmentSamples(samples || []);
      } catch {
        if (request === enrollmentRequest.current) setEnrollmentError("unavailable");
      } finally {
        if (request === enrollmentRequest.current) setEnrollmentLoading(false);
      }
    },
    [working, renameWorking]
  );
  useEffect(() => {
    const id = Number(window.sessionStorage.getItem("peopleEnrollmentReturn"));
    if (id > 0) {
      window.sessionStorage.removeItem("peopleEnrollmentReturn");
      void openEnrollment(id);
    }
  }, [openEnrollment]);
  const playCandidate = async (candidate: EnrollmentCandidate) => {
    if (candidate.profileId !== enrollingId) return;
    const request = enrollmentRequest.current;
    enrollmentPlayer.current?.pause();
    if (enrollmentUrl.current) URL.revokeObjectURL(enrollmentUrl.current);
    setListened(null);
    setListeningId(candidate.id);
    setEnrollmentError("");
    try {
      const result = await window.electronAPI.playVoiceEnrollmentCandidate?.(candidate.id);
      if (request !== enrollmentRequest.current) return;
      if (!result?.wav || !result.token) throw Error("unavailable");
      const bytes = Uint8Array.from(atob(result.wav), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
      enrollmentUrl.current = url;
      const player = new Audio(url);
      enrollmentPlayer.current = player;
      player.onended = () => {
        if (request === enrollmentRequest.current) {
          void window.electronAPI
            .completeVoiceEnrollmentCandidate?.(candidate.id, result.token!)
            .then((completed) => {
              if (request === enrollmentRequest.current && completed?.success) {
                setListeningId(null);
                setListened({
                  id: candidate.id,
                  token: result.token!,
                  expiresAt: completed.expiresAt!,
                });
                setListeningNow(Date.now());
              } else if (request === enrollmentRequest.current) {
                setListeningId(null);
                setEnrollmentError(completed?.error || "playback_required");
              }
            })
            .catch(() => {
              if (request === enrollmentRequest.current) {
                setListeningId(null);
                setEnrollmentError("unavailable");
              }
            });
        }
      };
      player.onerror = () => {
        if (request === enrollmentRequest.current) {
          setListeningId(null);
          setEnrollmentError("unavailable");
        }
      };
      await player.play();
    } catch {
      if (request === enrollmentRequest.current) {
        setListeningId(null);
        setEnrollmentError("unavailable");
      }
    }
  };
  const decideCandidate = async (candidate: EnrollmentCandidate, choice: "approve" | "reject") => {
    if (listened?.id !== candidate.id || candidate.profileId !== enrollingId) return;
    if (Date.now() >= listened.expiresAt) {
      setListened(null);
      setEnrollmentError("playback_required");
      return;
    }
    const request = enrollmentRequest.current;
    setWorking(true);
    setEnrollmentError("");
    const rendererRefreshStart = performance.now();
    const result = await saveEnrollmentDecision(
      candidate,
      choice,
      listened.token,
      window.electronAPI,
      candidates,
      enrollmentSamples,
      refresh
    );
    if (request === enrollmentRequest.current) {
      setEnrollmentError(result.error);
      setCandidates(result.candidates);
      setEnrollmentSamples(result.samples);
      if (result.reasons) setEnrollmentReasons(result.reasons);
      if (result.timingId)
        void window.electronAPI.reportVoiceEnrollmentRefresh?.(
          result.timingId,
          performance.now() - rendererRefreshStart
        );
      if (
        result.committed ||
        [
          "playback_required",
          "candidate_unavailable",
          "span_mismatch",
          "person_or_meeting_changed",
          "already_approved",
        ].includes(result.error)
      )
        setListened(null);
    }
    setWorking(false);
  };
  const removeEnrollmentSample = async (sample: EnrollmentSample) => {
    if (sample.profileId !== enrollingId) return;
    const request = enrollmentRequest.current;
    setWorking(true);
    setEnrollmentError("");
    try {
      const result = await window.electronAPI.removeVoiceEnrollmentSample?.(sample.id);
      if (!result?.success) throw Error(result?.error || "unavailable");
      if (request !== enrollmentRequest.current) return;
      const samples = await window.electronAPI.listVoiceEnrollmentSamples?.(sample.profileId);
      if (request !== enrollmentRequest.current) return;
      setEnrollmentSamples(samples || []);
      await refresh();
    } catch (cause) {
      if (request === enrollmentRequest.current)
        setEnrollmentError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setWorking(false);
    }
  };
  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(false);
    try {
      if (!window.electronAPI.listPeopleActions) throw Error("unavailable");
      setActionHistory(await window.electronAPI.listPeopleActions());
    } catch {
      setHistoryError(true);
    } finally {
      setHistoryLoading(false);
    }
  }, []);
  const refresh = useCallback(async () => {
    void refreshHistory();
    setRefreshing(true);
    setError(false);
    try {
      if (!window.electronAPI.listPeople) throw Error("unavailable");
      setPeople(await window.electronAPI.listPeople());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [refreshHistory]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(
    () =>
      window.electronAPI.onPeopleChanged?.(() => {
        void refresh();
      }),
    [refresh]
  );
  useEffect(() => {
    if (!reviewOpen || loading || error) return;
    let alive = true;
    const replaceReview = (rows: Review[]) => {
      const active = document.activeElement;
      const buttons = [
        ...(reviewScroll.current?.querySelectorAll<HTMLButtonElement>("[data-review-row-key]") ||
          []),
      ];
      if (active instanceof HTMLButtonElement && buttons.includes(active)) {
        reviewFocus.current = {
          element: active,
          key: active.dataset.reviewRowKey || "",
          index: buttons.indexOf(active),
        };
      }
      setReview(rows);
    };
    setReviewLoading(true);
    setReviewLoaded(false);
    setReviewError(false);
    setReviewProgress(null);
    const load = async () => {
      const loadPage = window.electronAPI.listPeopleReviewPage;
      if (loadPage) {
        let page = await loadPage(null);
        if (!alive) return;
        replaceReview(page.rows);
        const pending = page.pending;
        setReviewProgress(pending.length ? { current: 0, total: pending.length } : null);
        for (const [index, noteId] of pending.entries()) {
          // Let the dialog paint the cached rows and each progress update.
          await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
          if (!alive) return;
          page = await loadPage(noteId);
          if (!alive) return;
          replaceReview(page.rows);
          setReviewProgress({ current: index + 1, total: pending.length });
        }
      } else {
        if (!window.electronAPI.listPeopleReview) throw Error("unavailable");
        const rows = await window.electronAPI.listPeopleReview(null);
        if (alive) replaceReview(rows);
      }
    };
    void load()
      .catch(() => {
        if (alive) setReviewError(true);
      })
      .finally(() => {
        if (alive) {
          setReviewLoading(false);
          setReviewLoaded(true);
          setReviewProgress(null);
        }
      });
    return () => {
      alive = false;
    };
  }, [reviewOpen, loading, error, reviewReload]);
  const selectedId = selected?.id;
  const request: Request | null = useMemo(
    () =>
      selectedId !== undefined
        ? {
            type: kind,
            profileId: selectedId,
            ...(kind === "rename" ? { name: name.trim() } : {}),
            ...(kind === "merge" ? { survivorId } : {}),
          }
        : null,
    [selectedId, kind, name, survivorId]
  );
  const valid =
    !!request && (kind !== "rename" || !!name.trim()) && (kind !== "merge" || !!survivorId);
  useEffect(() => {
    if (!valid || !request) {
      setPreview(null);
      return;
    }
    let alive = true;
    setPreviewLoading(true);
    setPreview(null);
    void window.electronAPI
      .previewPersonAction?.(request)
      .then((result) => {
        if (alive) setPreview(result);
      })
      .catch(() => {
        if (alive) setPreview({ success: false, error: "persistence_failed" });
      })
      .finally(() => {
        if (alive) setPreviewLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [request, valid]);
  const shown = useMemo(
    () =>
      people
        .filter((p) => matchesPerson(p, query))
        .sort((a, b) =>
          sort === "usage"
            ? b.noteCount - a.noteCount ||
              b.segmentCount - a.segmentCount ||
              a.displayName.localeCompare(b.displayName)
            : (b.lastSeen || "").localeCompare(a.lastSeen || "") ||
              a.displayName.localeCompare(b.displayName)
        ),
    [people, query, sort]
  );
  const reasons = useMemo(
    () => [...new Set(review.map((r) => r.reason).filter((r) => r !== "person"))].sort(),
    [review]
  );
  const matchingReview = useMemo(
    () =>
      review.filter(
        (r) =>
          (personFilter || r.reason !== "person") &&
          (!reason || r.reason === reason) &&
          (!personFilter || String(r.profileId) === personFilter)
      ),
    [review, reason, personFilter]
  );
  const shownReview = useMemo(
    () => matchingReview.filter((row) => !eligibleOnly || !row.eligibilityReason),
    [matchingReview, eligibleOnly]
  );
  const excludedReview = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const row of matchingReview) {
      if (row.eligibilityReason)
        counts[row.eligibilityReason] = (counts[row.eligibilityReason] || 0) + 1;
    }
    return counts;
  }, [matchingReview]);
  const reasonLabel = (row: Review) =>
    row.reason === "person"
      ? t("people.reasons.person")
      : row.reason === "unassessed"
        ? t("notes.speaker.notAssessed")
        : row.reason === "close_match" && row.candidates
          ? t("notes.speaker.reason.closeMatch", {
              first: row.candidates[0],
              second: row.candidates[1],
            })
          : t(`notes.speaker.reason.${row.reason}`, {
              defaultValue: t("people.reasons.uncertain"),
            });
  const filterReasonLabel = (value: string) =>
    value === "close_match"
      ? t("people.reasons.close_match")
      : reasonLabel({ reason: value, candidates: null } as Review);
  const actionErrorText = (value: string) =>
    value === "history_quarantined"
      ? t("notes.speaker.historyQuarantined")
      : t(`people.errors.${value}`, { defaultValue: t("people.actionError") });
  const start = (person: Person, action: Kind) => {
    if (working || renameWorking) return;
    setEditingId(null);
    if (enrollingId !== null) closeEnrollment(false);
    setSelected(person);
    setKind(action);
    setName(person.displayName);
    setSurvivorId(0);
    setActionError("");
  };
  const closeRename = (returnFocus = true) => {
    const id = editingId;
    setEditingId(null);
    setRenameError("");
    if (returnFocus)
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLButtonElement>(`[data-rename-trigger="${id}"]`)
          ?.focus({ preventScroll: true })
      );
  };
  const saveRename = async (person: Person) => {
    const nextName = draftName.trim();
    if (!nextName || renameWorking) return;
    if (nextName === person.displayName) {
      closeRename();
      return;
    }
    setRenameWorking(true);
    setRenameError("");
    try {
      const request = { type: "rename" as const, profileId: person.id, name: nextName };
      const checked = await window.electronAPI.previewPersonAction?.(request);
      if (!checked?.success) throw Error(checked?.error || "persistence_failed");
      const result = await window.electronAPI.applyPersonAction?.({
        ...request,
        expected: {
          noteCount: checked.noteCount || 0,
          segmentCount: checked.segmentCount || 0,
          pinnedCount: checked.pinnedCount || 0,
          historyCount: checked.historyCount || 0,
          noteEmbeddingCount: checked.noteEmbeddingCount || 0,
        },
      });
      if (!result?.success || !result.id) throw Error(result?.error || "persistence_failed");
      toast({
        title: t("people.done", {
          action: t("people.actions.rename"),
          name: person.displayName,
          notes: result.noteCount || 0,
          segments: result.segmentCount || 0,
        }),
        actions: [{ label: t("people.undo"), onClick: () => undo(result.id!) }],
      });
      setEditingId(null);
      await refresh();
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLButtonElement>(`[data-rename-trigger="${person.id}"]`)
          ?.focus({ preventScroll: true })
      );
    } catch (cause) {
      setRenameError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setRenameWorking(false);
    }
  };
  const closePreview = (returnFocus = true) => {
    const id = selected?.id;
    setSelected(null);
    if (returnFocus)
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(`[data-person-menu="${id}"]`)
          ?.focus({ preventScroll: true })
      );
  };
  const closeEnrollment = (returnFocus = true) => {
    const id = enrollingId;
    enrollmentRequest.current++;
    enrollmentPlayer.current?.pause();
    setEnrollingId(null);
    setListened(null);
    setCandidates([]);
    setEnrollmentSamples([]);
    if (returnFocus)
      requestAnimationFrame(() => {
        const trigger = document.querySelector<HTMLElement>(
          enrollmentFromMenu.current
            ? `[data-person-menu="${id}"]`
            : `[data-enroll-trigger="${id}"]`
        );
        (trigger || document.querySelector<HTMLElement>(`[data-person-menu="${id}"]`))?.focus({
          preventScroll: true,
        });
      });
  };
  const newestActionIndex = actionHistory.findIndex((item) => !item.unavailableReason);
  const execute = async () => {
    if (!request || !preview?.success || working) return;
    const currentIndex = shown.findIndex((person) => person.id === request.profileId);
    const focusId =
      kind === "merge"
        ? survivorId
        : kind === "delete"
          ? shown[currentIndex + 1]?.id || shown[currentIndex - 1]?.id
          : request.profileId;
    setWorking(true);
    setActionError("");
    try {
      const result = await window.electronAPI.applyPersonAction?.({
        ...request,
        expected: {
          noteCount: preview.noteCount || 0,
          segmentCount: preview.segmentCount || 0,
          pinnedCount: preview.pinnedCount || 0,
          historyCount: preview.historyCount || 0,
          noteEmbeddingCount: preview.noteEmbeddingCount || 0,
        },
      });
      if (!result?.success || (kind !== "delete" && !result.id))
        throw Error(result?.error || "persistence_failed");
      toast({
        title:
          kind === "reset"
            ? t("people.doneReset", { name: selected!.displayName })
            : t("people.done", {
                action: t(`people.actions.${kind}`),
                name: selected!.displayName,
                notes: result.noteCount || 0,
                segments: result.segmentCount || 0,
              }),
        ...(kind !== "delete" && result.id
          ? { actions: [{ label: t("people.undo"), onClick: () => undo(result.id!) }] }
          : {}),
      });
      setSelected(null);
      await refresh();
      requestAnimationFrame(() => {
        const target =
          focusId && document.querySelector<HTMLElement>(`[data-person-row="${focusId}"]`);
        (target || document.querySelector<HTMLElement>("[data-people-list-header]"))?.focus({
          preventScroll: true,
        });
      });
    } catch (cause) {
      setActionError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setWorking(false);
    }
  };
  const undo = async (id: string) => {
    if (!id || working) return;
    setWorking(true);
    setActionError("");
    try {
      const result = await window.electronAPI.undoPersonAction?.(id);
      if (!result?.success) throw Error(result?.error || "persistence_failed");
      toast({ title: t("people.undo") });
      await refresh();
    } catch (cause) {
      setActionError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setWorking(false);
    }
  };
  const previewClear = async () => {
    setActionError("");
    setClearPreview(null);
    setClearConfirmation("");
    setClearPreviewLoading(true);
    try {
      const result = await window.electronAPI.previewClearVoiceData?.();
      if (!result?.success) throw Error("persistence_failed");
      setClearPreview(result);
    } catch {
      setActionError("persistence_failed");
    } finally {
      setClearPreviewLoading(false);
    }
  };
  const applyClear = async () => {
    if (!clearPreview || working || clearConfirmation !== t("people.clearVoice")) return;
    setWorking(true);
    setActionError("");
    try {
      const result = await window.electronAPI.clearVoiceData?.(clearPreview);
      if (!result?.success || !result.id) throw Error(result?.error || "persistence_failed");
      setClearReport({
        id: result.id,
        personCount: result.personCount || 0,
        embeddingCount: result.embeddingCount || 0,
        mappingCount: result.mappingCount || 0,
      });
      setClearPreview(null);
      setClearConfirmation("");
      await refresh();
    } catch (cause) {
      setActionError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setWorking(false);
    }
  };
  const undoClear = async () => {
    if (!clearReport || working) return;
    setWorking(true);
    setActionError("");
    try {
      const result = await window.electronAPI.undoClearVoiceData?.(clearReport.id);
      if (!result?.success) throw Error(result?.error || "persistence_failed");
      setClearReport(null);
      await refresh();
    } catch (cause) {
      setActionError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setWorking(false);
    }
  };
  const undoHistory = async (action: HistoryAction) => {
    if (working) return;
    setWorking(true);
    setActionError("");
    try {
      const result =
        action.kind === "calibration"
          ? await window.electronAPI.undoSpeakerCalibration?.(action.id)
          : action.kind === "clear_voice"
            ? await window.electronAPI.undoClearVoiceData?.(action.id)
            : action.kind === "enrollment"
              ? await window.electronAPI.undoVoiceEnrollmentAction?.(action.id)
              : ["apply", "correction", "split", "reconsideration"].includes(action.kind) &&
                  action.noteId
                ? await window.electronAPI.applySpeakerCorrection?.({
                    type: "undo",
                    noteId: action.noteId,
                    id: action.id,
                  })
                : action.kind === "mapping" && action.noteId
                  ? await window.electronAPI.undoPeopleMapping?.(action.noteId)
                  : action.kind === "adoption" && action.noteId
                    ? await window.electronAPI.takeCloudSpeakerLabels?.(action.noteId, true)
                    : await window.electronAPI.undoPersonAction?.(action.id);
      if (!result?.success) throw Error(result?.error || "persistence_failed");
      if (action.kind === "calibration") {
        const current = await window.electronAPI.speakerCalibrationSettings?.();
        if (current) setCalibration(current);
        setCalibrationUndoId(null);
      }
      setClearReport(null);
      await refresh();
    } catch (cause) {
      setActionError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setWorking(false);
    }
  };
  const date = (value: string | null) =>
    value
      ? new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`).toLocaleDateString(
          locale,
          { year: "numeric", month: "short", day: "numeric" }
        )
      : t("people.never");
  const shortDate = (value: string) => {
    const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
    return parsed.toLocaleDateString(locale === "en" ? "en-GB" : locale, {
      day: "numeric",
      month: "short",
      ...(parsed.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
    });
  };
  return (
    <div
      ref={rootRef}
      data-capturing={working || renameWorking ? "" : undefined}
      className="space-y-5 pb-8 text-foreground"
    >
      <div
        data-people-list-header
        tabIndex={-1}
        className="space-y-4 outline-none focus:ring-2 focus:ring-ring"
      >
        <SectionHeader title={t("people.title")} description={t("people.subtitle")} />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <ProviderTabs
            providers={[
              { id: "people", name: t("people.tabs.people") },
              { id: "history", name: t("people.historyPage") },
              { id: "voice", name: t("people.voiceSettings") },
            ]}
            selectedId={view}
            onSelect={(id) => selectPage(id as PeopleTab)}
            renderIcon={(id) =>
              id === "people" ? (
                <Users className="w-3.5 h-3.5" />
              ) : id === "history" ? (
                <Clock className="w-3.5 h-3.5" />
              ) : (
                <Settings2 className="w-3.5 h-3.5" />
              )
            }
            ariaLabel={t("people.title")}
            wrap
          />
          <Button
            ref={reviewTrigger}
            type="button"
            variant="secondary"
            aria-haspopup="dialog"
            aria-expanded={reviewOpen}
            onClick={() => setReviewOpen(true)}
          >
            <ClipboardCheck className="size-4" />
            {t("people.tabs.review")}
          </Button>
        </div>
      </div>
      <div className={view === "people" ? "space-y-4" : "hidden"}>
        {refreshing && !loading && (
          <p role="status" className="text-xs text-muted-foreground">
            {t("people.loading")}
          </p>
        )}
        {loading && (
          <div role="status" className="space-y-2" aria-label={t("people.loading")}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-32 rounded-lg" />
            ))}
            <p className="text-sm text-muted-foreground">{t("people.loading")}</p>
          </div>
        )}
        {error && !loading && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{t("people.loadError")}</AlertDescription>
            <Button variant="outline" className="mt-3" onClick={() => void refresh()}>
              {t("people.retry")}
            </Button>
          </Alert>
        )}
        {!loading && (!error || people.length > 0) && (
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input
                dir="auto"
                aria-label={t("people.search")}
                placeholder={t("people.search")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Select value={sort} onValueChange={(value) => setSort(value as typeof sort)}>
                <SelectTrigger aria-label={t("people.sort")} className="w-auto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="usage">{t("people.sortUsage")}</SelectItem>
                  <SelectItem value="heard">{t("people.sortHeard")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {people.length === 0 && (
              <EmptyStateCard
                icon={Users}
                title={t("people.emptyTitle")}
                description={t("people.emptyBody")}
                headingLevel={2}
              />
            )}
            {people.length > 0 && shown.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("people.noMatches")}
              </p>
            )}
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
              {shown.map((p) => (
                <div
                  key={p.id}
                  data-person-row={p.id}
                  tabIndex={-1}
                  className="grid min-h-60 content-center gap-x-5 gap-y-3 px-4 py-4 outline-none focus:ring-2 focus:ring-inset focus:ring-ring sm:min-h-44 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5"
                >
                  {selected?.id === p.id ? (
                    <div className="col-span-full min-w-0">
                      <strong
                        dir="auto"
                        className="block truncate text-sm font-semibold text-foreground"
                      >
                        {p.displayName || p.email || t("people.noName")}
                      </strong>
                      <FocusScope
                        trapped={false}
                        loop={false}
                        onMountAutoFocus={(event) => event.preventDefault()}
                        onUnmountAutoFocus={(event) => event.preventDefault()}
                      >
                        <div
                          className="mt-3"
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              if (!working) closePreview();
                            }
                          }}
                        >
                          <Alert
                            role="alertdialog"
                            aria-labelledby={`person-action-title-${p.id}`}
                            aria-describedby={`person-action-description-${p.id}`}
                            variant={
                              kind === "delete" || kind === "reset" ? "destructive" : "default"
                            }
                          >
                            <AlertTitle id={`person-action-title-${p.id}`}>
                              {t(`people.actions.${kind}`)} ·{" "}
                              {p.displayName || p.email || t("people.noName")}
                            </AlertTitle>
                            <AlertDescription id={`person-action-description-${p.id}`}>
                              {kind === "merge" && (
                                <div className="mt-3 max-w-sm">
                                  <Label id={`people-survivor-label-${p.id}`}>
                                    {t("people.survivor")}
                                  </Label>
                                  <Select
                                    disabled={working}
                                    value={survivorId ? String(survivorId) : "__choose__"}
                                    onValueChange={(value) =>
                                      setSurvivorId(value === "__choose__" ? 0 : Number(value))
                                    }
                                  >
                                    <SelectTrigger
                                      ref={survivorTrigger}
                                      aria-labelledby={`people-survivor-label-${p.id}`}
                                      className="mt-1"
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="__choose__">
                                        {t("people.choosePerson")}
                                      </SelectItem>
                                      {people
                                        .filter((person) => person.id !== p.id)
                                        .map((person) => (
                                          <SelectItem key={person.id} value={String(person.id)}>
                                            {person.displayName}
                                          </SelectItem>
                                        ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                              )}
                              {previewLoading && (
                                <p role="status" className="mt-3">
                                  {t("people.loadingPreview")}
                                </p>
                              )}
                              {preview?.success && (
                                <p className="mt-3">
                                  {kind === "delete" ? (
                                    <>
                                      {t("people.deletePreview", {
                                        notes: preview.noteCount,
                                        segments: preview.segmentCount,
                                        history: preview.historyCount,
                                      })}
                                      {p.meetingCount > 0 &&
                                        p.segmentCount === 0 &&
                                        !p.hasVoice && <> {t("people.attendeeDeleteReappears")}</>}
                                    </>
                                  ) : kind === "reset" ? (
                                    t("people.resetPreview", {
                                      samples: preview.voiceSamples,
                                      notes: preview.noteCount,
                                      segments: preview.segmentCount,
                                    })
                                  ) : (
                                    t("people.previewCounts", {
                                      notes: preview.noteCount,
                                      segments: preview.segmentCount,
                                      pinned: preview.pinnedCount,
                                    })
                                  )}{" "}
                                  {["delete", "reset"].includes(kind) &&
                                    t("people.noteVoiceEvidence", {
                                      count: preview.noteEmbeddingCount || 0,
                                    })}{" "}
                                  {t(`people.scope.${kind}`)}
                                </p>
                              )}
                              {preview && !preview.success && (
                                <p role="alert" className="mt-3 text-destructive">
                                  {actionErrorText(preview.error || "persistence_failed")}
                                </p>
                              )}
                              {actionError && (
                                <p role="alert" className="mt-3 text-destructive">
                                  {actionErrorText(actionError)}
                                </p>
                              )}
                              <div className="mt-4 flex flex-wrap gap-2">
                                <Button
                                  ref={actionCancel}
                                  type="button"
                                  size="sm"
                                  variant="secondary"
                                  disabled={working}
                                  onClick={() => closePreview()}
                                >
                                  {t("people.cancel")}
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant={
                                    kind === "delete" || kind === "reset"
                                      ? "destructive"
                                      : "default"
                                  }
                                  disabled={!preview?.success || working}
                                  onClick={() => void execute()}
                                >
                                  {working ? t("people.working") : t(`people.actions.${kind}`)}
                                </Button>
                              </div>
                              {working && (
                                <p role="status" className="mt-2">
                                  {t("people.waitForSave")}
                                </p>
                              )}
                            </AlertDescription>
                          </Alert>
                        </div>
                      </FocusScope>
                    </div>
                  ) : enrollingId === p.id ? (
                    <div className="col-span-full min-w-0">
                      <strong
                        dir="auto"
                        className="block truncate text-sm font-semibold text-foreground"
                      >
                        {p.displayName || p.email || t("people.noName")}
                      </strong>
                      <FocusScope
                        trapped={false}
                        loop={false}
                        onMountAutoFocus={(event) => event.preventDefault()}
                        onUnmountAutoFocus={(event) => event.preventDefault()}
                      >
                        <section
                          tabIndex={-1}
                          className="mt-3 rounded-xl border border-border bg-surface-2/40 p-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          role="dialog"
                          aria-label={`${t("people.enrollVoice")} · ${p.displayName || p.email || t("people.noName")}`}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              if (!working) closeEnrollment();
                            }
                          }}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <SectionHeader
                              title={`${t("people.enrollVoice")} · ${people.find((p) => p.id === enrollingId)?.displayName || ""}`}
                            />
                            <Button
                              ref={enrollmentCancelRef}
                              type="button"
                              size="sm"
                              variant="secondary"
                              disabled={working}
                              onClick={() => closeEnrollment()}
                            >
                              {t("people.cancel")}
                            </Button>
                          </div>
                          <p className="mt-2 text-sm text-muted-foreground">
                            {t("people.enrollmentIntro")}
                          </p>
                          <div className="mt-4 flex flex-wrap items-center gap-2">
                            <Badge variant={p.voiceProgress.usable ? "success" : "outline"}>
                              {t("people.enrollmentProgress", {
                                spans: p.voiceProgress.cleanSpans,
                                meetings: p.voiceProgress.meetings,
                              })}
                            </Badge>
                            {p.voiceProgress.usable && (
                              <Badge variant="success">{t("people.voiceUsable")}</Badge>
                            )}
                          </div>
                          <Progress
                            className="mt-2 max-w-sm"
                            value={Math.min(100, (p.voiceProgress.cleanSpans / 3) * 100)}
                            aria-label={t("people.enrollmentProgress", {
                              spans: p.voiceProgress.cleanSpans,
                              meetings: p.voiceProgress.meetings,
                            })}
                          />
                          {enrollmentError && (
                            <p role="alert" className="mt-3 text-sm text-destructive">
                              {t(`people.enrollmentErrors.${enrollmentError}`, {
                                defaultValue: t("people.actionError"),
                              })}
                            </p>
                          )}
                          {listened && (
                            <p role="status" className="mt-2 text-sm text-muted-foreground">
                              {t("people.listeningTimeLeft", {
                                minutes: Math.floor(listeningSeconds / 60),
                                seconds: String(listeningSeconds % 60).padStart(2, "0"),
                              })}
                            </p>
                          )}
                          {working && (
                            <p role="status" className="mt-2 text-sm">
                              {t("people.waitForSave")}
                            </p>
                          )}
                          {enrollmentLoading && (
                            <p role="status" className="mt-3 text-sm text-muted-foreground">
                              {t("people.loading")}
                            </p>
                          )}
                          {!enrollmentLoading && candidates.length === 0 && (
                            <Alert className="mt-3">
                              <AlertTitle>{t("people.noEnrollmentCandidates")}</AlertTitle>
                              <AlertDescription>
                                {Object.entries(enrollmentReasons).some(
                                  ([, count]) => count > 0
                                ) ? (
                                  <ul className="mt-2 list-inside list-disc space-y-1">
                                    {Object.entries(enrollmentReasons)
                                      .filter(([, count]) => count > 0)
                                      .map(([reason, count]) => (
                                        <li key={reason}>
                                          {t(`people.enrollmentReasons.${reason}`, { count })}
                                        </li>
                                      ))}
                                  </ul>
                                ) : (
                                  <p className="mt-2">{t("people.noLabelledEnrollmentRows")}</p>
                                )}
                              </AlertDescription>
                            </Alert>
                          )}
                          <div className="mt-3 divide-y divide-border rounded-lg border border-border">
                            {candidates.map((candidate) => (
                              <div
                                key={candidate.id}
                                className="flex flex-wrap items-center justify-between gap-3 p-3"
                              >
                                <div>
                                  <p className="text-sm font-medium">{candidate.noteTitle}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {date(candidate.meetingDate)} ·{" "}
                                    {t("people.enrollmentDuration", {
                                      seconds: new Intl.NumberFormat(locale, {
                                        maximumFractionDigits: 1,
                                      }).format(candidate.durationSeconds),
                                    })}{" "}
                                    {candidate.everCorrected && (
                                      <> · {t("people.ownerCorrected")}</>
                                    )}
                                  </p>
                                </div>
                                <div className="flex gap-2">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="secondary"
                                    disabled={listeningId !== null || working}
                                    onClick={() => void playCandidate(candidate)}
                                  >
                                    {listeningId === candidate.id
                                      ? t("people.playing")
                                      : t("people.listen")}
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    disabled={
                                      working ||
                                      listened?.id !== candidate.id ||
                                      listeningSeconds === 0
                                    }
                                    onClick={() => void decideCandidate(candidate, "approve")}
                                  >
                                    {t("people.approveSample")}
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="secondary"
                                    disabled={
                                      working ||
                                      listened?.id !== candidate.id ||
                                      listeningSeconds === 0
                                    }
                                    onClick={() => void decideCandidate(candidate, "reject")}
                                  >
                                    {t("people.rejectSample")}
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                          {enrollmentSamples.length > 0 && (
                            <div className="mt-4">
                              <SectionHeader title={t("people.approvedSamples")} />
                              <div className="divide-y divide-border rounded-lg border border-border">
                                {enrollmentSamples.map((sample) => (
                                  <div
                                    key={sample.id}
                                    className={`flex flex-wrap items-center justify-between gap-3 p-3 ${sample.odd ? "bg-warning/10" : ""}`}
                                  >
                                    <span className="text-sm">
                                      {sample.noteTitle} · {date(sample.meetingDate)}
                                      {sample.odd && <> · {t("people.oddSample")}</>}
                                    </span>
                                    <div className="flex gap-2">
                                      {sample.odd && (
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="secondary"
                                          disabled={working || !onOpenNote}
                                          onClick={() => {
                                            savePeopleReturn();
                                            window.sessionStorage.setItem(
                                              "peopleReturnNoteTitle",
                                              sample.noteTitle
                                            );
                                            window.sessionStorage.setItem(
                                              "peopleEnrollmentReturn",
                                              String(p.id)
                                            );
                                            onOpenNote?.(sample.noteId, sample.rowIds[0]);
                                          }}
                                        >
                                          {t("people.splitSample")}
                                        </Button>
                                      )}
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="secondary"
                                        disabled={working}
                                        onClick={() => void removeEnrollmentSample(sample)}
                                      >
                                        {t("people.removeSample")}
                                      </Button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </section>
                      </FocusScope>
                    </div>
                  ) : (
                    <>
                      <div className="min-w-0">
                        {editingId === p.id ? (
                          <FocusScope
                            trapped={false}
                            loop={false}
                            onMountAutoFocus={(event) => event.preventDefault()}
                            onUnmountAutoFocus={(event) => event.preventDefault()}
                          >
                            <form
                              role="alertdialog"
                              aria-labelledby={`person-rename-title-${p.id}`}
                              className="flex min-w-0 flex-wrap items-center gap-2"
                              onSubmit={(event) => {
                                event.preventDefault();
                                void saveRename(p);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  if (!renameWorking) closeRename();
                                }
                              }}
                            >
                              <span id={`person-rename-title-${p.id}`} className="sr-only">
                                {t("people.actions.rename")} ·{" "}
                                {p.displayName || p.email || t("people.noName")}
                              </span>
                              <Input
                                ref={renameInput}
                                dir="auto"
                                disabled={renameWorking}
                                aria-label={t("people.newName")}
                                className="max-w-xs"
                                maxLength={120}
                                value={draftName}
                                onChange={(event) => setDraftName(event.target.value)}
                              />
                              <Button
                                type="submit"
                                size="sm"
                                disabled={!draftName.trim() || renameWorking}
                              >
                                {renameWorking ? t("people.working") : t("people.saveName")}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                disabled={renameWorking}
                                onClick={() => closeRename()}
                              >
                                {t("people.cancel")}
                              </Button>
                              {renameWorking && (
                                <span role="status" className="text-xs text-muted-foreground">
                                  {t("people.waitForSave")}
                                </span>
                              )}
                            </form>
                          </FocusScope>
                        ) : (
                          <div className="group/name flex min-w-0 items-center gap-1.5">
                            <strong
                              dir="auto"
                              className="min-w-0 truncate text-sm font-semibold text-foreground"
                              title={p.displayName || p.email || undefined}
                            >
                              {p.displayName || p.email || t("people.noName")}
                            </strong>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              data-rename-trigger={p.id}
                              disabled={working || renameWorking}
                              className="size-7 text-muted-foreground opacity-60 group-hover/name:opacity-100 focus-visible:opacity-100"
                              aria-label={`${t("people.actions.rename")} · ${p.displayName || p.email || t("people.noName")}`}
                              onClick={() => {
                                setSelected(null);
                                if (enrollingId !== null) closeEnrollment(false);
                                setDraftName(p.displayName === p.email ? "" : p.displayName);
                                setRenameError("");
                                setEditingId(p.id);
                              }}
                            >
                              <Pencil className="size-3.5" aria-hidden="true" />
                            </Button>
                          </div>
                        )}
                        {p.email &&
                          p.displayName &&
                          p.email.trim().toLocaleLowerCase() !==
                            p.displayName.trim().toLocaleLowerCase() && (
                            <p
                              dir="auto"
                              className="mt-0.5 truncate text-xs text-muted-foreground"
                              title={p.email}
                            >
                              {p.email}
                            </p>
                          )}
                        {p.email &&
                          (!p.displayName ||
                            p.displayName.trim().toLocaleLowerCase() ===
                              p.email.trim().toLocaleLowerCase()) && (
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {t("people.noName")}
                            </p>
                          )}
                        {renameError && editingId === p.id && (
                          <p role="alert" className="mt-1 text-xs text-destructive">
                            {actionErrorText(renameError)}
                          </p>
                        )}
                        <p className="mt-2 text-xs tabular-nums text-muted-foreground">
                          {p.meetingCount
                            ? t(
                                p.meetingCount === 1
                                  ? "people.meetingSingular"
                                  : "people.meetingCountCompact",
                                { count: p.meetingCount }
                              )
                            : t("people.noMeetingsYet")}
                          {" · "}
                          {t(
                            p.noteCount === 1 ? "people.noteSingular" : "people.noteCountCompact",
                            {
                              count: p.noteCount,
                            }
                          )}
                          {" · "}
                          {t(
                            p.segmentCount === 1
                              ? "people.segmentSingular"
                              : "people.segmentCountCompact",
                            { count: p.segmentCount }
                          )}
                          {p.lastSeen && (
                            <> · {t("people.lastSeen", { date: shortDate(p.lastSeen) })}</>
                          )}
                        </p>
                        <div className="mt-4 flex flex-wrap items-center gap-1.5">
                          <Badge
                            variant={
                              p.voiceProgress.usable
                                ? "success"
                                : p.hasVoice || p.voiceProgress.cleanSpans > 0
                                  ? "warning"
                                  : "outline"
                            }
                            className="text-[11px]"
                          >
                            {p.voiceProgress.usable
                              ? t("people.voiceGraduated", {
                                  spans: p.voiceProgress.cleanSpans,
                                  meetings: p.voiceProgress.meetings,
                                })
                              : p.hasVoice || p.voiceProgress.cleanSpans > 0
                                ? t("people.voiceProvisional")
                                : t("people.noVoice")}
                          </Badge>
                          {p.duplicates.map((d) => (
                            <Badge key={d.id} variant="warning" className="text-[11px]">
                              {t("people.duplicate", { name: d.name })}
                            </Badge>
                          ))}
                          {p.hasVoice && p.needsReapproval && (
                            <Badge variant="warning" className="text-[11px]">
                              {t("meetingAudio.reapproval")}
                            </Badge>
                          )}
                          {p.segmentCount > 0 && p.usedOnce && (
                            <Badge variant="outline" className="text-[11px]">
                              {t("people.usedOnce")}
                            </Badge>
                          )}
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="link"
                          className="mt-1 h-auto px-0 text-xs text-muted-foreground"
                          aria-expanded={expandedId === p.id}
                          aria-controls={`person-detail-${p.id}`}
                          onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
                        >
                          {t(expandedId === p.id ? "people.hideDetails" : "people.showDetails")}
                        </Button>
                      </div>
                      <div className="flex items-center justify-end gap-2 sm:self-center">
                        {!p.voiceProgress.usable && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline-flat"
                            data-enroll-trigger={p.id}
                            disabled={working || renameWorking}
                            onClick={() => void openEnrollment(p.id)}
                          >
                            {p.hasVoice || p.voiceProgress.cleanSpans > 0
                              ? t("people.reviewSpans")
                              : t("people.enrollVoice")}
                          </Button>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              data-person-menu={p.id}
                              disabled={working || renameWorking}
                              className="size-9 text-muted-foreground"
                              aria-label={`${t("people.moreActions")} · ${p.displayName || p.email || t("people.noName")}`}
                            >
                              <MoreHorizontal className="size-5" aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {p.voiceProgress.usable && (
                              <DropdownMenuItem onSelect={() => void openEnrollment(p.id, true)}>
                                {t("people.enrollVoice")}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onSelect={() => start(p, "merge")}>
                              {t("people.actions.merge")}
                            </DropdownMenuItem>
                            {p.hasVoice && (
                              <DropdownMenuItem onSelect={() => start(p, "reset")}>
                                {t("people.actions.reset")}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              className="mt-1 border-t border-border pt-2 text-destructive focus:text-destructive"
                              onSelect={() => start(p, "delete")}
                            >
                              {t("people.actions.delete")}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      {expandedId === p.id && (
                        <div
                          id={`person-detail-${p.id}`}
                          className="col-span-full rounded-lg bg-surface-2/50 p-3 text-xs text-muted-foreground"
                        >
                          <p>
                            {p.hasVoice || p.voiceProgress.cleanSpans > 0 ? (
                              <>
                                {t("people.enrollmentProgress", {
                                  spans: p.voiceProgress.cleanSpans,
                                  meetings: p.voiceProgress.meetings,
                                })}{" "}
                                ·{" "}
                                {t(
                                  p.voiceProgress.usable
                                    ? "people.voiceUsable"
                                    : "people.voiceProvisional"
                                )}
                              </>
                            ) : (
                              t("people.noVoice")
                            )}
                          </p>
                          {p.legacyVoice && <p className="mt-1">{t("people.legacyVoice")}</p>}
                          {p.voiceProgress.conflict && (
                            <p role="alert" className="mt-1 text-foreground">
                              {t("people.voiceConflict")}
                            </p>
                          )}
                          {p.lastHeard && (
                            <p className="mt-1">
                              {t("people.lastHeard", { date: date(p.lastHeard) })}
                            </p>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {view === "history" && (
        <div className="space-y-4">
          <SectionHeader title={t("people.actionHistory")} />
          {historyLoading && <p role="status">{t("people.loading")}</p>}
          {historyError && (
            <Alert role="alert" variant="destructive">
              <AlertDescription>{t("people.actionError")}</AlertDescription>
              <Button variant="outline" className="mt-3" onClick={() => void refreshHistory()}>
                {t("people.retry")}
              </Button>
            </Alert>
          )}
          {!historyError && (
            <section
              className="max-h-[min(70vh,680px)] overflow-y-auto rounded-xl border border-border p-4"
              aria-label={t("people.actionHistory")}
            >
              <p className="mt-1 text-xs text-muted-foreground">{t("people.undoOrder")}</p>
              {actionHistory.length === 0 && (
                <p className="mt-2 text-xs text-muted-foreground">{t("people.noActions")}</p>
              )}
              <ol className="mt-2 space-y-2">
                {actionHistory.map((action, index) => (
                  <li
                    key={`${action.id}:${action.noteId}`}
                    className={`flex items-center justify-between gap-3 text-xs ${index !== newestActionIndex ? "opacity-60" : "rounded-lg bg-surface-2/50 p-2"}`}
                  >
                    <span className="min-w-0 break-words">
                      {action.kind === "calibration"
                        ? t("people.calibrationTitle")
                        : action.kind === "clear_voice"
                          ? t("people.clearVoice")
                          : ["apply", "correction"].includes(action.kind)
                            ? t("people.correctionAction")
                            : action.kind === "split"
                              ? t("notes.speaker.splitCluster")
                              : action.kind === "enrollment"
                                ? t(
                                    action.label.startsWith("approve:")
                                      ? "people.approveSample"
                                      : action.label.startsWith("reject:")
                                        ? "people.rejectSample"
                                        : "people.removeSample"
                                  )
                                : action.kind === "reconsideration"
                                  ? t("notes.speaker.reason.approved_voice")
                                  : action.kind === "mapping"
                                    ? t("people.mappingAction")
                                    : action.kind === "adoption"
                                      ? t("people.adoptionAction")
                                      : t(`people.actions.${action.kind}`)}
                      {[
                        "rename",
                        "merge",
                        "delete",
                        "reset",
                        "apply",
                        "correction",
                        "mapping",
                        "adoption",
                      ].includes(action.kind) && (
                        <>
                          {" "}
                          ·{" "}
                          {action.label === "deleted_person"
                            ? t("people.deletedPerson")
                            : action.label === "Unknown"
                              ? t("people.unknown")
                              : action.label}
                        </>
                      )}
                      {action.noteInTrash ? ` · ${t("people.noteInTrash")}` : ""}
                    </span>
                    {action.unavailableReason ? (
                      <span className="text-muted-foreground">
                        {actionErrorText(action.unavailableReason)}
                      </span>
                    ) : index !== newestActionIndex ? (
                      <span className="text-muted-foreground">
                        {t("people.errors.later_change")}
                      </span>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={working}
                        onClick={() => void undoHistory(action)}
                      >
                        {t("people.undo")}
                      </Button>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      )}
      {view === "voice" && (
        <div className="space-y-6">
          <SectionHeader title={t("people.voiceSettings")} />
          <section
            className="rounded-xl border border-border p-4"
            aria-label={t("people.calibrationTitle")}
          >
            <SectionHeader title={t("people.calibrationTitle")} />
            <p className="mt-1 text-xs text-muted-foreground">
              {t("people.calibrationInstructions")}
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <fieldset className="text-xs">
                <legend>{t("people.calibrationScope")}</legend>
                <div className="mt-1 flex flex-wrap gap-2">
                  {(["all", "range"] as const).map((option) => (
                    <label key={option} className="flex cursor-pointer items-center gap-2">
                      <input
                        type="radio"
                        name="calibration-scope"
                        className="accent-primary"
                        checked={calibrationScope === option}
                        onChange={() => setCalibrationScope(option)}
                      />
                      {t(option === "all" ? "people.calibrationAll" : "people.calibrationRange")}
                    </label>
                  ))}
                </div>
              </fieldset>
              {calibrationScope === "range" && (
                <div className="flex gap-2">
                  <label className="text-xs">
                    {t("people.calibrationFrom")}
                    <Input
                      dir="ltr"
                      className="w-full"
                      type="date"
                      value={calibrationFrom}
                      onChange={(event) => setCalibrationFrom(event.target.value)}
                    />
                  </label>
                  <label className="text-xs">
                    {t("people.calibrationTo")}
                    <Input
                      dir="ltr"
                      className="w-full"
                      type="date"
                      value={calibrationTo}
                      onChange={(event) => setCalibrationTo(event.target.value)}
                    />
                  </label>
                </div>
              )}
              <label className="text-xs">
                {t("people.calibrationNoteBudget")}
                <Input
                  dir="ltr"
                  className="w-full"
                  type="number"
                  min="1"
                  max="1000"
                  value={calibrationNotes}
                  onChange={(event) => setCalibrationNotes(Math.max(1, Number(event.target.value)))}
                />
              </label>
              <label className="text-xs">
                {t("people.calibrationRowBudget")}
                <Input
                  dir="ltr"
                  className="w-full"
                  type="number"
                  min="1"
                  max="10000"
                  value={calibrationRows}
                  onChange={(event) => setCalibrationRows(Math.max(1, Number(event.target.value)))}
                />
              </label>
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={calibrationJob?.state === "running"}
                onClick={() => void startCalibration()}
              >
                {t("people.calibrationRun")}
              </Button>
              {calibrationJob?.state === "running" && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void window.electronAPI.cancelSpeakerCalibration?.()}
                >
                  {t("people.calibrationCancel")}
                </Button>
              )}
              {calibrationUndoId && (
                <Button type="button" variant="outline" onClick={() => void undoCalibration()}>
                  {t("people.calibrationUndo")}
                </Button>
              )}
            </div>
            {calibrationJob && (
              <p role="status" className="mt-2 text-xs text-muted-foreground">
                {calibrationJob.state}: {calibrationJob.progress.processedRows}/
                {calibrationJob.progress.totalRows} {t("people.calibrationRows")};{" "}
                {calibrationJob.progress.reembeddedRows} {t("people.calibrationReembedded")};{" "}
                {calibrationJob.progress.bytesRead} {t("people.calibrationBytes")};{" "}
                {Math.round(calibrationJob.progress.elapsedMs / 1000)}{" "}
                {t("people.calibrationSeconds")}
              </p>
            )}
            {calibration && (
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {calibrationFields.map((key) => (
                  <div key={key} className="rounded-lg bg-muted/40 p-3 text-xs">
                    <strong className="block">{t(`people.calibrationFields.${key}`)}</strong>
                    <span>
                      {calibration.values[key]} ·{" "}
                      {calibration.statuses?.[key] === "calibrated"
                        ? t("people.calibrated")
                        : t("people.uncalibrated")}
                    </span>
                    {key === "similarityFloor" && calibration.statuses?.[key] !== "calibrated" && (
                      <p className="mt-1 text-muted-foreground">
                        {t("people.calibrationFixedFloor")}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
            {calibrationReport && (
              <SpeakerCalibrationReport
                report={calibrationReport}
                onApply={() => void applyCalibration()}
              />
            )}
            {calibrationError && (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {calibrationError}
              </p>
            )}
          </section>

          <section
            className="space-y-3 border-t border-border pt-6"
            aria-label={t("people.voiceData")}
          >
            <SectionHeader title={t("people.voiceData")} />
            <div>
              <Button
                ref={clearTrigger}
                type="button"
                variant="destructive"
                disabled={clearPreviewLoading || working}
                onClick={() => void previewClear()}
              >
                {t("people.clearVoice")}
              </Button>
              {clearPreviewLoading && (
                <p role="status" className="mt-2 text-xs text-muted-foreground">
                  {t("people.loadingPreview")}
                </p>
              )}
              {clearReport && (
                <div role="status" className="mt-3 text-sm">
                  <p>
                    {t("people.clearDone", {
                      people: clearReport.personCount,
                      embeddings: clearReport.embeddingCount,
                      mappings: clearReport.mappingCount,
                    })}
                  </p>
                  {historyLoading ||
                  historyError ||
                  actionHistory.length === 0 ||
                  actionHistory.find((item) => !item.unavailableReason)?.id === clearReport.id ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="mt-2"
                      disabled={working}
                      onClick={() => void undoClear()}
                    >
                      {t("people.undo")}
                    </Button>
                  ) : (
                    <p className="mt-2 text-muted-foreground">{t("people.errors.later_change")}</p>
                  )}
                </div>
              )}
              {actionError && !selected && (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  {actionErrorText(actionError)}
                </p>
              )}
            </div>
          </section>
        </div>
      )}
      <Dialog
        open={!!clearPreview}
        onOpenChange={(open) => {
          if (!open && !working) {
            setClearPreview(null);
            setClearConfirmation("");
          }
        }}
      >
        <DialogContent
          closeDisabled={working}
          aria-describedby="people-clear-description"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            clearInput.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            clearTrigger.current?.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(event) => {
            if (working) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("people.clearVoice")}</DialogTitle>
          </DialogHeader>
          {clearPreview && (
            <div id="people-clear-description" className="space-y-2 text-sm">
              <ul className="list-inside list-disc space-y-1">
                <li>{t("people.clearVectors", { count: clearPreview.embeddingCount })}</li>
                <li>{t("people.clearNoteVectors", { count: clearPreview.noteEmbeddingCount })}</li>
                <li>{t("people.clearSamples", { count: clearPreview.sampleCount })}</li>
                <li>{t("people.clearCandidates", { count: clearPreview.candidateCount })}</li>
                <li>{t("people.clearMappings", { count: clearPreview.mappingCount })}</li>
                <li>{t("people.clearKept", { count: clearPreview.personCount })}</li>
              </ul>
            </div>
          )}
          <Label htmlFor="people-clear-confirm">
            {t("people.clearTypePrompt", { phrase: t("people.clearVoice") })}
          </Label>
          <Input
            id="people-clear-confirm"
            ref={clearInput}
            dir="auto"
            value={clearConfirmation}
            onChange={(event) => setClearConfirmation(event.target.value)}
            disabled={working}
            autoComplete="off"
          />
          {working && (
            <p role="status" className="text-sm text-muted-foreground">
              {t("people.waitForSave")}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={working}
              onClick={() => {
                setClearPreview(null);
                setClearConfirmation("");
              }}
            >
              {t("people.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={working || clearConfirmation !== t("people.clearVoice")}
              onClick={() => void applyClear()}
            >
              {working ? t("people.working") : t("people.clearVoice")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={reviewOpen}
        onOpenChange={(open) => {
          setReviewOpen(open);
          if (!open) window.sessionStorage.removeItem(reviewReturnKey);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            reviewTrigger.current?.focus({ preventScroll: true });
          }}
          aria-describedby={undefined}
          className="max-h-[min(85vh,760px)] w-[calc(100vw-2rem)] max-w-3xl overflow-hidden"
        >
          <DialogHeader>
            <DialogTitle>{t("people.tabs.review")}</DialogTitle>
          </DialogHeader>
          <div
            ref={reviewScroll}
            className="max-h-[min(65vh,620px)] min-h-0 space-y-4 overflow-y-auto pe-1"
          >
            {reviewLoading && (
              <p role="status" className="text-sm text-muted-foreground">
                {reviewProgress
                  ? t("people.reviewChecking", {
                      current: reviewProgress.current,
                      total: reviewProgress.total,
                    })
                  : t("people.loading")}
              </p>
            )}
            {reviewError && (
              <div role="alert" className="rounded-xl border border-destructive/30 p-4 text-sm">
                {t("people.loadError")}{" "}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setReviewReload((value) => value + 1)}
                >
                  {t("people.retry")}
                </Button>
              </div>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              <Select
                value={reason || "__all__"}
                onValueChange={(value) => {
                  setReason(value === "__all__" ? "" : value);
                  setLimit(100);
                }}
              >
                <SelectTrigger aria-label={t("people.filterReason")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t("people.allReasons")}</SelectItem>
                  {reasons.map((r) => (
                    <SelectItem key={r} value={r}>
                      {filterReasonLabel(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={personFilter || "__all__"}
                onValueChange={(value) => {
                  setPersonFilter(value === "__all__" ? "" : value);
                  setLimit(100);
                }}
              >
                <SelectTrigger aria-label={t("people.filterPerson")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t("people.allPeople")}</SelectItem>
                  {people.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!reviewError && (
              <div className="space-y-1 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={eligibleOnly}
                    onChange={(event) => {
                      setEligibleOnly(event.target.checked);
                      try {
                        window.localStorage.setItem(
                          reviewEligibleKey,
                          String(event.target.checked)
                        );
                      } catch {
                        /* storage unavailable */
                      }
                      setLimit(100);
                    }}
                  />
                  {t("people.reviewEligibleOnly")}
                </label>
                <p className="text-muted-foreground">
                  {t("people.reviewShowing", {
                    shown: shownReview.length,
                    total: matchingReview.length,
                  })}
                </p>
                {eligibleOnly && Object.keys(excludedReview).length > 0 && (
                  <details className="text-muted-foreground">
                    <summary>{t("people.reviewExcluded")}</summary>
                    <ul className="ps-5">
                      {Object.entries(excludedReview).map(([key, count]) => (
                        <li key={key}>
                          {t(`people.enrollmentReasons.${key === "limit" ? "reviewLimit" : key}`, {
                            count,
                          })}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
            {!reviewLoading && !reviewError && shownReview.length === 0 && (
              <p className="rounded-xl border border-border p-6 text-sm text-muted-foreground">
                {eligibleOnly && matchingReview.length > 0
                  ? t("people.noEnrollmentCandidates")
                  : t("people.reviewEmpty")}
              </p>
            )}
            <div className="divide-y divide-border rounded-xl border border-border">
              {shownReview.slice(0, limit).map((r) => (
                <div
                  key={`${r.noteId}:${r.rowId}`}
                  className="grid gap-2 p-4 sm:grid-cols-[1fr_auto] sm:items-center"
                >
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">
                      {r.noteTitle} · {reasonLabel(r)}
                    </p>
                    <p className="mt-1 line-clamp-2 text-sm">{r.text}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {r.speakerName || t("people.unknown")}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    data-review-row-key={`${r.noteId}:${r.rowId}`}
                    disabled={!onOpenNote}
                    onClick={() => {
                      savePeopleReturn();
                      window.sessionStorage.setItem("peopleReturnNoteTitle", r.noteTitle);
                      window.sessionStorage.setItem(
                        reviewReturnKey,
                        JSON.stringify({
                          reason,
                          personFilter,
                          limit,
                          scrollTop: reviewScroll.current?.scrollTop || 0,
                        } satisfies ReviewReturn)
                      );
                      setReviewOpen(false);
                      toast({ title: t("hooks.audioRecording.errorActions.viewTranscript") });
                      onOpenNote?.(r.noteId, r.rowId);
                    }}
                  >
                    {t("people.openRow")}
                  </Button>
                </div>
              ))}
            </div>
            {shownReview.length > limit && (
              <Button type="button" variant="outline" onClick={() => setLimit(limit + 100)}>
                {t("people.showMore")}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
