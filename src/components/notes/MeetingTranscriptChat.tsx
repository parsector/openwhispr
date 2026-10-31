import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, Loader2, Sparkles, Users, X } from "../icons";
import { useStickToBottom } from "../../hooks/useStickToBottom";
import { Popover, PopoverTrigger, PopoverContent } from "../ui/popover";
import { Toggle } from "../ui/toggle";
import { cn } from "../lib/utils";
import { MAX_SPEAKER_COUNT } from "../../constants/speakerDetection.json";
import type { TranscriptSegment } from "../../stores/meetingRecordingStore";
import { latestCorrection } from "../../utils/transcriptCorrections";
import { projectSpeakerActions } from "../../utils/speakerActionProjection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import type { Commitment } from "../../types/electron";
import { groupFor } from "../todos/TodoGroups";
import { sourceChipsByIndex } from "../todos/sourceChips";
import {
  MeetingAudioPlayback,
  PlaybackUnavailableError,
  playbackRange,
} from "../../utils/meetingAudioPlayback";
import {
  isSelfSideSegment,
  isTranscriptSpeakerLocked,
  isYouSpeakerName,
  normalizeTranscriptSegments,
  resolveSegmentSpeakerName,
  type TranscriptSpeakerStatus,
} from "../../utils/transcriptSpeakerState";

const BUBBLE_STYLES = {
  mic: {
    align: "justify-start",
    radius: "rounded-es-sm",
    bg: "bg-primary/60 text-primary-foreground/80",
    cursor: "bg-primary-foreground/60",
  },
  system: {
    align: "justify-end",
    radius: "rounded-ee-sm",
    bg: "bg-surface-2/70 border border-border/70 text-foreground/80",
    cursor: "bg-foreground/40",
  },
} as const;

const SPEAKER_BORDER_COLORS = [
  "border-s-info/50",
  "border-s-success/50",
  "border-s-accent/50",
  "border-s-warning/50",
  "border-s-primary/50",
  "border-s-foreground/50",
  "border-s-muted-foreground/50",
  "border-s-destructive/50",
];

// One unlabelled line of transcript; measureElement corrects each row on mount.
const ESTIMATED_ROW_PX = 56;
// Renders a screenful before the scroll element has been measured, instead of
// an empty list for one frame. Replaced by the real rect on mount.
const INITIAL_VIEWPORT_RECT = { width: 400, height: 600 };

const getEffectiveSpeakerKey = (
  segment: TranscriptSegment,
  speakerMappings?: Record<string, string>
): string => {
  const name = resolveSegmentSpeakerName(segment, speakerMappings);
  if (name) return `name:${name.toLowerCase()}`;
  if (segment.speaker)
    return `id:${segment.diarizationRunId || "legacy"}:${segment.speaker}:${segment.unknownNumber || ""}`;
  return `src:${segment.source}`;
};

const getSpeakerNumber = (speakerId: string) => {
  const match = speakerId.match(/speaker_(\d+)/);
  return match ? Number(match[1]) + 1 : 1;
};

const getSpeakerStateLabel = (state: TranscriptSpeakerStatus, t: (key: string) => string) => {
  switch (state) {
    case "locked":
      return t("notes.speaker.state.locked");
    case "provisional":
      return t("notes.speaker.state.provisional");
    case "suggested":
      return t("notes.speaker.state.suggested");
    case "confirmed":
    default:
      return t("notes.speaker.state.confirmed");
  }
};

function PartialBubble({
  text,
  source,
  speakerLabel,
  speakerState,
  t,
}: {
  text: string;
  source: "mic" | "system";
  speakerLabel?: string;
  speakerState?: TranscriptSpeakerStatus;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const s = BUBBLE_STYLES[source];
  return (
    <div
      className={cn("flex", s.align)}
      style={{ animation: "agent-message-in 150ms ease-out both" }}
    >
      <div className="max-w-[80%] flex flex-col">
        {speakerLabel && (
          <div className="mb-0.5 flex items-center gap-1 px-1">
            <span dir="auto" className="text-[11px] font-medium text-muted-foreground/70">
              {speakerLabel}
            </span>
            {speakerState === "provisional" && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-muted-foreground/70">
                <Sparkles size={9} />
                {getSpeakerStateLabel("provisional", t)}
              </span>
            )}
          </div>
        )}
        <div
          className={cn(
            "px-3 py-1.5 rounded-lg",
            s.radius,
            s.bg,
            "text-[13px] leading-relaxed italic"
          )}
        >
          <span dir="auto">{text}</span>
          <span
            className={cn("inline-block w-[2px] h-[13px] align-middle ms-0.5", s.cursor)}
            style={{ animation: "agent-cursor-blink 800ms steps(1) infinite" }}
          />
        </div>
      </div>
    </div>
  );
}

const isLikelyEmail = (value: string) => /.+@.+\..+/.test(value.trim());

const nameFromEmail = (email: string) => email.split("@")[0] || email;

interface SpeakerProfileLite {
  id?: number;
  display_name: string;
  email: string | null;
}

interface SpeakerPickerProps {
  speakerProfiles?: SpeakerProfileLite[];
  participants?: Array<{ email: string; displayName: string | null }>;
  onSelectName: (name: string, email?: string | null, profileId?: number) => void;
  onClose: () => void;
  // Selecting a name, including "This is me", only assigns labels.
  self?: "offer" | "exclude";
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function AddContactButton({
  profile,
  onAttachEmail,
  t,
}: {
  profile: { id: number; display_name: string };
  onAttachEmail: (profileId: number, email: string | null) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const canSave = isLikelyEmail(draft);

  const submit = () => {
    if (!canSave) return;
    onAttachEmail(profile.id, draft.trim().toLowerCase());
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setDraft("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex items-center mb-0.5 px-1.5 py-0.5 rounded-md text-[11px] outline-none cursor-pointer",
            "border border-dashed border-border/70 dark:border-white/15",
            "text-foreground/50 hover:text-foreground hover:border-border/90 dark:hover:border-white/30",
            "transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-ring"
          )}
        >
          {t("notes.speaker.addContact")}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3">
        <div dir="auto" className="text-xs font-medium text-foreground truncate mb-2">
          {profile.display_name}
        </div>
        <input
          dir="ltr"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={t("notes.speaker.emailPlaceholder")}
          className={cn(
            "w-full px-2 py-1.5 rounded-md bg-transparent text-xs text-foreground",
            "placeholder:text-foreground/45 outline-none",
            "border border-border/70 focus:border-border/90 transition-colors"
          )}
          autoFocus
          type="email"
        />
        <div className="flex justify-end gap-1 mt-2">
          <button
            onClick={() => setOpen(false)}
            className="px-2 py-1 rounded text-[11px] text-foreground/50 hover:text-foreground hover:bg-foreground/5 transition-colors cursor-pointer"
          >
            {t("notes.speaker.cancel")}
          </button>
          <button
            onClick={submit}
            disabled={!canSave}
            className={cn(
              "px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer",
              "bg-primary text-primary-foreground hover:bg-primary/90",
              "disabled:bg-primary/20 disabled:text-primary-foreground/40 disabled:pointer-events-none"
            )}
          >
            {t("notes.speaker.save")}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SpeakerPicker({
  speakerProfiles,
  participants,
  onSelectName,
  onClose,
  self,
  t,
}: SpeakerPickerProps) {
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lower = search.toLowerCase();
  const trimmed = search.trim();
  const trimmedLower = trimmed.toLowerCase();

  const youLabel = t("notes.speaker.you");
  const youLower = youLabel.trim().toLowerCase();
  const thisIsMe = t("notes.speaker.thisIsMe");
  const selfProfiles = self
    ? (speakerProfiles || []).filter((p) => isYouSpeakerName(p.display_name, youLabel))
    : [];
  // Reuse the existing identity label without changing its voice embedding.
  const selfProfile = selfProfiles.find((p) => p.id != null) ?? selfProfiles[0];
  const matchesSelf =
    !!self &&
    !!trimmed &&
    (isYouSpeakerName(trimmed, youLabel) ||
      selfProfiles.some((p) => p.email?.toLowerCase() === trimmedLower));
  const showSelf =
    self === "offer" &&
    (!trimmed ||
      matchesSelf ||
      youLower.includes(trimmedLower) ||
      thisIsMe.toLowerCase().includes(trimmedLower) ||
      !!selfProfile?.email?.toLowerCase().includes(trimmedLower));

  const filteredParticipants = (participants || []).filter(
    (p) =>
      !search ||
      (p.displayName || "").toLowerCase().includes(lower) ||
      p.email.toLowerCase().includes(lower)
  );
  const filteredProfiles = (speakerProfiles || []).filter(
    (p) =>
      !selfProfiles.includes(p) &&
      (!search ||
        p.display_name.toLowerCase().includes(lower) ||
        (p.email && p.email.toLowerCase().includes(lower)))
  );

  const hasExactMatch =
    matchesSelf ||
    filteredParticipants.some(
      (p) =>
        (p.displayName || "").toLowerCase() === trimmedLower ||
        p.email.toLowerCase() === trimmedLower
    ) ||
    filteredProfiles.some(
      (p) =>
        p.display_name.toLowerCase() === trimmedLower ||
        (p.email && p.email.toLowerCase() === trimmedLower)
    );
  const canCreate = !!trimmed && !hasExactMatch;
  const inputIsEmail = isLikelyEmail(trimmed);

  const submitCreate = () => {
    if (!canCreate) return;
    if (inputIsEmail) {
      const email = trimmed.toLowerCase();
      onSelectName(nameFromEmail(email), email);
    } else {
      onSelectName(trimmed, null);
    }
    setSearch("");
  };

  const selectSelf = () =>
    onSelectName(
      selfProfile?.display_name ?? youLabel,
      selfProfile?.email ?? null,
      selfProfile?.id
    );

  const visibleParticipants = filteredParticipants.slice(0, 5);
  const visibleProfiles = filteredProfiles.slice(0, 5);
  const selectionRows = [
    ...(showSelf ? [selectSelf] : []),
    ...visibleParticipants.map(
      (p) => () =>
        onSelectName(
          p.displayName || p.email.split("@")[0],
          p.email,
          speakerProfiles?.find((profile) => profile.email?.toLowerCase() === p.email.toLowerCase())
            ?.id
        )
    ),
    ...visibleProfiles.map((p) => () => onSelectName(p.display_name, p.email, p.id)),
  ];
  const createIndex = selectionRows.length;
  const rows = canCreate ? [...selectionRows, submitCreate] : selectionRows;

  useEffect(() => {
    if (activeIndex !== null) {
      listRef.current
        ?.querySelector(`[data-speaker-picker-index="${activeIndex}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
    }
  }, [activeIndex]);

  const rowClassName = (index: number) =>
    cn(
      "flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs text-foreground/70 hover:bg-foreground/5 transition-colors cursor-pointer",
      activeIndex === index && "bg-foreground/10 text-foreground"
    );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length) {
        setActiveIndex((current) =>
          current === null
            ? e.key === "ArrowDown"
              ? 0
              : rows.length - 1
            : (current + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length
        );
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex !== null) rows[activeIndex]?.();
      else selectionRows[0]?.();
    }
  };

  const isEmpty =
    !showSelf && !filteredParticipants.length && !filteredProfiles.length && !canCreate;

  return (
    <>
      <div className="p-2 border-b border-border/70">
        <input
          dir="auto"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setActiveIndex(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder={t("notes.speaker.nameOrEmailPlaceholder")}
          className="w-full px-2 py-1.5 rounded-md bg-transparent text-xs text-foreground placeholder:text-foreground/45 outline-none border-none appearance-none"
          autoFocus
        />
      </div>
      <div ref={listRef} className="max-h-52 overflow-y-auto">
        {showSelf && (
          <div className="p-1 border-b border-border/70">
            <button
              data-speaker-picker-index={0}
              onClick={selectionRows[0]}
              className={rowClassName(0)}
            >
              <span dir="auto" className="truncate flex-1 text-start">
                {thisIsMe}
              </span>
            </button>
          </div>
        )}
        {filteredParticipants.length > 0 && (
          <div className="p-1 border-b border-border/70">
            <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
              {t("notes.speaker.meetingAttendees")}
            </div>
            {visibleParticipants.map((p, index) => (
              <button
                key={p.email}
                data-speaker-picker-index={index + (showSelf ? 1 : 0)}
                onClick={selectionRows[index + (showSelf ? 1 : 0)]}
                className={rowClassName(index + (showSelf ? 1 : 0))}
              >
                <span dir="auto" className="truncate flex-1 text-start">
                  {p.displayName || p.email}
                </span>
                {p.displayName && (
                  <span dir="ltr" className="text-foreground/45 truncate text-[11px]">
                    {p.email}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {filteredProfiles.length > 0 && (
          <div className="p-1 border-b border-border/70">
            <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
              {t("notes.speaker.knownSpeakers")}
            </div>
            {visibleProfiles.map((p, index) => (
              <button
                key={p.id ?? `name-${p.display_name}`}
                data-speaker-picker-index={index + (showSelf ? 1 : 0) + visibleParticipants.length}
                onClick={selectionRows[index + (showSelf ? 1 : 0) + visibleParticipants.length]}
                className={rowClassName(index + (showSelf ? 1 : 0) + visibleParticipants.length)}
              >
                <span dir="auto" className="truncate flex-1 text-start">
                  {p.display_name}
                </span>
                {p.email && (
                  <span dir="ltr" className="text-foreground/45 truncate text-[11px]">
                    {p.email}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {canCreate && (
          <div className="p-1">
            <button
              data-speaker-picker-index={createIndex}
              onClick={submitCreate}
              className={rowClassName(createIndex)}
            >
              <span className="text-foreground/50 shrink-0">
                {t("notes.speaker.createNewPrefix")}
              </span>
              {inputIsEmail ? (
                <>
                  <span dir="auto" className="text-foreground truncate">
                    {nameFromEmail(trimmed)}
                  </span>
                  <span dir="ltr" className="text-foreground/45 truncate text-[11px]">
                    {trimmed.toLowerCase()}
                  </span>
                </>
              ) : (
                <span dir="auto" className="text-foreground truncate">
                  {trimmed}
                </span>
              )}
            </button>
          </div>
        )}
        {isEmpty && (
          <div className="px-3 py-4 text-center text-[11px] text-foreground/45">
            {t("notes.speaker.nameOrEmailPlaceholder")}
          </div>
        )}
      </div>
    </>
  );
}

function SpeakerLabel({
  speakerId,
  segment,
  resolvedName,
  speakerProfiles,
  participants,
  isOriginallyYou,
  self,
  onMap,
  onAssignScope,
  onSplitCluster,
  onUndoCorrection,
  selectedRowIds,
  selectedClusterCount,
  clusterRowCount,
  onConfirm,
  onDismiss,
  t,
}: {
  speakerId: string;
  segment: TranscriptSegment;
  resolvedName?: string;
  speakerProfiles?: SpeakerProfileLite[];
  participants?: Array<{ email: string; displayName: string | null }>;
  isOriginallyYou: boolean;
  self?: "offer" | "exclude";
  onMap?: (speakerId: string, name: string, email?: string | null, profileId?: number) => void;
  onAssignScope?: (
    scope: "row" | "selected" | "cluster",
    rowId: string,
    name: string | null,
    profileId?: number,
    email?: string | null
  ) => void;
  onSplitCluster?: (rowId: string) => void;
  onUndoCorrection?: (id: string) => void;
  selectedRowIds?: Set<string>;
  selectedClusterCount: number;
  clusterRowCount: number;
  onConfirm?: (speakerId: string, name: string, profileId: number) => void;
  onDismiss?: (speakerId: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"row" | "selected" | "cluster">("row");
  const storedName = segment.speakerIsPlaceholder ? undefined : segment.speakerName;
  const speakerState =
    segment.speakerLocked || isTranscriptSpeakerLocked(segment)
      ? "locked"
      : segment.speakerStatus ||
        (segment.suggestedName && !resolvedName
          ? "suggested"
          : storedName || resolvedName
            ? "confirmed"
            : segment.speakerIsPlaceholder
              ? "provisional"
              : undefined);

  const hasSuggestion = !!segment.suggestedName && !resolvedName;

  const displayLabel =
    resolvedName ||
    storedName ||
    (isOriginallyYou && !isTranscriptSpeakerLocked(segment)
      ? t("notes.speaker.you")
      : speakerId === "speaker_mic"
        ? t("notes.speaker.unknownNumber", { n: segment.unknownNumber ?? 1 })
        : t("notes.speaker.unknownNumber", { n: segment.unknownNumber ?? 1 }));
  const isUnmapped = !resolvedName && !storedName;

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setScope("row");
        }}
      >
        <PopoverTrigger asChild>
          <button
            data-speaker-chip
            type="button"
            disabled={!onMap && !onAssignScope}
            className={cn(
              "inline-flex items-center text-[11px] font-medium mb-0.5 px-1.5 py-0.5 rounded-md outline-none cursor-pointer",
              "border border-border/70",
              "hover:bg-foreground/5 hover:border-border/90",
              "transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
              "text-foreground",
              isUnmapped && "border-dashed",
              speakerState === "provisional" && "italic"
            )}
          >
            <span dir="auto">{displayLabel}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0">
          <div
            className="flex gap-1 p-2 border-b border-border/70"
            role="group"
            aria-label={t("notes.speaker.scope.label")}
          >
            {(
              [
                "row",
                ...(selectedRowIds?.size ? ["selected"] : []),
                ...(segment.speaker ? ["cluster"] : []),
              ] as Array<"row" | "selected" | "cluster">
            ).map((choice) => (
              <button
                key={choice}
                type="button"
                aria-pressed={scope === choice}
                onClick={() => setScope(choice)}
                className={cn(
                  "rounded px-2 py-1 text-[11px] hover:bg-foreground/10",
                  scope === choice && "bg-foreground/10 font-medium"
                )}
              >
                {t(`notes.speaker.scope.${choice}`)}
              </button>
            ))}
          </div>
          {scope === "cluster" && (
            <div
              className="px-3 pt-2 text-[11px] text-muted-foreground"
              data-affected-rows={clusterRowCount}
            >
              {t("notes.speaker.scope.changesRows", { n: clusterRowCount })}
            </div>
          )}
          {clusterRowCount > 1 && segment.speaker && onSplitCluster && (
            <div className="border-b border-border/70 px-3 py-2">
              <p className="mb-1 text-[11px] text-muted-foreground">
                {t("notes.speaker.splitPreview", {
                  moved:
                    selectedClusterCount > 0 && selectedClusterCount < clusterRowCount
                      ? selectedClusterCount
                      : 1,
                  total: clusterRowCount,
                })}
              </p>
              <button
                type="button"
                className="rounded px-2 py-1 text-xs font-medium text-foreground hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  onSplitCluster(segment.id);
                  setOpen(false);
                }}
              >
                {t("notes.speaker.splitCluster")}
              </button>
            </div>
          )}
          <SpeakerPicker
            speakerProfiles={speakerProfiles}
            participants={participants}
            onSelectName={(name, email, profileId) => {
              if (scope === "cluster" || !onAssignScope) {
                if (segment.speaker) onMap?.(speakerId, name, email, profileId);
              } else if (email) onAssignScope(scope, segment.id, name, profileId, email);
              else onAssignScope(scope, segment.id, name, profileId);
              setOpen(false);
            }}
            onClose={() => setOpen(false)}
            self={self}
            t={t}
          />
          <div className="border-t border-border/70 px-2 py-1.5 flex items-center gap-2">
            {onAssignScope && (
              <button
                type="button"
                className="rounded px-2 py-1 text-[11px] hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  onAssignScope?.(scope, segment.id, null);
                  setOpen(false);
                }}
              >
                {t("notes.speaker.scope.unknown")}
              </button>
            )}
            {onUndoCorrection &&
              segment.corrections
                ?.filter((correction) => correction.undoAvailable)
                .map((correction) => (
                  <button
                    key={correction.id}
                    type="button"
                    className="rounded px-2 py-1 text-[11px] hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      onUndoCorrection?.(correction.id);
                      setOpen(false);
                    }}
                  >
                    {t("notes.speaker.restore")}
                  </button>
                ))}
          </div>
        </PopoverContent>
      </Popover>
      {hasSuggestion && (
        <span className="group inline-flex items-center gap-1 mb-0.5 px-1">
          <span dir="auto" className="text-[11px] font-medium italic text-muted-foreground/70">
            {segment.suggestedName}
          </span>
          {onConfirm && (
            <button
              type="button"
              onClick={() =>
                onConfirm(speakerId, segment.suggestedName!, segment.suggestedProfileId!)
              }
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-0.5 rounded transition-opacity cursor-pointer text-muted-foreground hover:text-success"
              aria-label={t("notes.speaker.confirmed")}
            >
              <Check size={12} />
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              onClick={() => onDismiss(speakerId)}
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-0.5 rounded transition-opacity cursor-pointer text-muted-foreground hover:text-destructive"
              aria-label={t("notes.speaker.cancel")}
            >
              <X size={12} />
            </button>
          )}
        </span>
      )}
    </>
  );
}

function SelectCheckbox({
  isSelected,
  onToggle,
  className,
}: {
  isSelected: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-pressed={isSelected}
      className={cn(
        "w-4 h-4 rounded-full border flex items-center justify-center transition-all cursor-pointer",
        isSelected
          ? "border-primary bg-primary text-primary-foreground opacity-100"
          : "border-border/70 bg-background/80 opacity-0 group-hover:opacity-100 hover:border-foreground/50",
        className
      )}
    >
      {isSelected && <Check size={10} strokeWidth={3} />}
    </button>
  );
}

export function SelectionBar({
  onClear,
  speakerProfiles,
  participants,
  onAssignName,
  selectedSegments,
  speakerMappings,
  t,
}: {
  onClear: () => void;
  speakerProfiles?: SpeakerProfileLite[];
  participants?: Array<{ email: string; displayName: string | null }>;
  onAssignName: (name: string, email?: string | null, profileId?: number) => void;
  selectedSegments: TranscriptSegment[];
  speakerMappings?: Record<string, string>;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [open, setOpen] = useState(false);
  const offerSelf = selectedSegments.some(
    (segment) => !isSelfSideSegment(segment, speakerMappings, t("notes.speaker.you"))
  );
  return (
    <div
      className="flex items-center gap-3 rounded-md border border-border/70 bg-surface-2/95 backdrop-blur px-3 py-1.5 text-xs shadow-lg"
      style={{ animation: "agent-message-in 150ms ease-out both" }}
    >
      <span className="text-foreground/70 tabular-nums">
        {t("notes.speaker.selected", { n: selectedSegments.length })}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button className="inline-flex items-center gap-1 px-2 py-1 rounded text-foreground hover:bg-foreground/10 transition-colors cursor-pointer">
            <Users size={12} />
            {t("notes.speaker.assignTo")}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0">
          <SpeakerPicker
            speakerProfiles={speakerProfiles}
            participants={participants}
            onSelectName={(name, email, profileId) => {
              onAssignName(name, email, profileId);
              setOpen(false);
            }}
            onClose={() => setOpen(false)}
            self={offerSelf ? "offer" : undefined}
            t={t}
          />
        </PopoverContent>
      </Popover>
      <button
        onClick={onClear}
        className="px-2 py-1 rounded text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors cursor-pointer"
      >
        {t("notes.speaker.deselectAll")}
      </button>
    </div>
  );
}

interface SegmentRowProps {
  segment: TranscriptSegment;
  sourceChips?: Commitment[];
  onOpenSourceTodos?: () => void;
  selfSide: boolean;
  sameSpeaker: boolean;
  isFirst: boolean;
  isNewest: boolean;
  colorIdx: number;
  isSelected: boolean;
  activeName?: string;
  matchedProfile?: SpeakerProfileLite;
  speakerProfiles?: SpeakerProfileLite[];
  participants?: Array<{ email: string; displayName: string | null }>;
  onAssignSpeakerScope?: (
    scope: "row" | "selected" | "cluster",
    rowId: string,
    name: string | null,
    profileId?: number,
    email?: string | null
  ) => void;
  onSplitCluster?: (rowId: string) => void;
  onUndoCorrection?: (id: string) => void;
  selectedRowIds?: Set<string>;
  selectedClusterCount: number;
  clusterRowCount: number;
  onMapSpeaker?: (
    speakerId: string,
    displayName: string,
    email?: string | null,
    profileId?: number
  ) => void;
  onConfirmSuggestion?: (speakerId: string, suggestedName: string, profileId: number) => void;
  onDismissSuggestion?: (speakerId: string) => void;
  onAttachSpeakerEmail?: (profileId: number, email: string | null) => void;
  onToggleSelect?: (segmentId: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
  audioState?: string;
  audioUnavailableReason?: "timebase" | "gap" | "track";
  playing?: boolean;
  onPlayAudio?: (segment: TranscriptSegment) => void;
}

// Memoized so live partials (several per second) only re-render the two partial
// bubbles, not every settled row. Everything a row displays arrives as a prop
// whose identity/value only changes when that row's rendering changes. Only the
// arriving row animates in: a virtualized row remounts whenever it scrolls back
// into view, so older rows would replay their entrance.
const SegmentRow = memo(function SegmentRow({
  segment,
  sourceChips,
  onOpenSourceTodos,
  selfSide,
  sameSpeaker,
  isFirst,
  isNewest,
  colorIdx,
  isSelected,
  activeName,
  matchedProfile,
  speakerProfiles,
  participants,
  onMapSpeaker,
  onAssignSpeakerScope,
  onSplitCluster,
  onUndoCorrection,
  selectedRowIds,
  selectedClusterCount,
  clusterRowCount,
  onConfirmSuggestion,
  onDismissSuggestion,
  onAttachSpeakerEmail,
  onToggleSelect,
  t,
  audioState,
  audioUnavailableReason,
  playing,
  onPlayAudio,
}: SegmentRowProps) {
  const hasSpeaker =
    !!segment.speaker || !!segment.speakerName || !!segment.source || !!segment.speakerLocked;
  const isOriginallyYou = segment.speaker === "you";
  const isSystemSpeaker = hasSpeaker && !selfSide;
  // Mic location alone cannot identify the owner. A remote voice is never
  // offered as the owner; mic clusters can be assigned explicitly.
  const self =
    segment.source === "system" ? "exclude" : !selfSide && !isOriginallyYou ? "offer" : undefined;
  const selectable = !!onToggleSelect;

  // The user's own voice profile isn't a contact.
  const canAddContact =
    !!matchedProfile &&
    matchedProfile.id != null &&
    !matchedProfile.email &&
    !isYouSpeakerName(matchedProfile.display_name, t("notes.speaker.you")) &&
    !!onAttachSpeakerEmail;
  const rowAction = latestCorrection(segment);
  const rowChangeNote =
    rowAction?.kind === "split"
      ? t("notes.speaker.splitCluster")
      : rowAction?.kind === "correction" &&
          rowAction.actor === "user" &&
          rowAction.previous.speakerName !== rowAction.next.speakerName
        ? `${t("people.correctionAction")}: ${rowAction.previous.speakerName || t("people.unknown")} → ${rowAction.next.speakerName || t("people.unknown")}`
        : null;

  const labelElement = hasSpeaker && (
    <div className="flex items-center gap-1">
      <SpeakerLabel
        speakerId={segment.speaker || ""}
        segment={segment}
        resolvedName={activeName}
        speakerProfiles={speakerProfiles}
        participants={participants}
        isOriginallyYou={isOriginallyYou}
        self={self}
        onMap={onMapSpeaker}
        onAssignScope={onAssignSpeakerScope}
        onSplitCluster={onSplitCluster}
        onUndoCorrection={onUndoCorrection}
        selectedRowIds={selectedRowIds}
        selectedClusterCount={selectedClusterCount}
        clusterRowCount={clusterRowCount}
        onConfirm={onConfirmSuggestion}
        onDismiss={onDismissSuggestion}
        t={t}
      />
      {canAddContact && matchedProfile && matchedProfile.id != null && (
        <AddContactButton
          profile={{ id: matchedProfile.id, display_name: matchedProfile.display_name }}
          onAttachEmail={onAttachSpeakerEmail!}
          t={t}
        />
      )}
    </div>
  );

  return (
    <div
      className={cn(
        "group flex flex-col",
        selfSide ? "items-start" : "items-end",
        !sameSpeaker && !isFirst && "mt-2",
        selectable && (selfSide ? "ps-6" : "pe-6")
      )}
      style={isNewest ? { animation: "agent-message-in 200ms ease-out both" } : undefined}
    >
      {labelElement}
      {(segment.uncertainty ||
        segment.changedAfterFinal ||
        segment.machineReason ||
        rowChangeNote ||
        (onUndoCorrection && rowAction) ||
        segment.quarantinedCorrections?.length ||
        (!segment.speakerAssessmentAvailable &&
          !segment.speakerLocked &&
          !segment.speakerName)) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pb-0.5 text-[11px] text-muted-foreground">
          {segment.importedUnlabeled && !segment.speakerName && (
            <span>{t("notes.speaker.importedUnlabeled")}</span>
          )}
          {!segment.importedUnlabeled &&
            !segment.speakerAssessmentAvailable &&
            !segment.speakerLocked &&
            !segment.speakerName && <span>{t("notes.speaker.notAssessed")}</span>}
          {!!segment.quarantinedCorrections?.length && (
            <span>
              {t("notes.speaker.correctionHistoryUnresolved", {
                n: segment.quarantinedCorrections.length,
              })}
            </span>
          )}
          {segment.uncertainty && (
            <span>
              {segment.uncertainty.reason === "close_match" && segment.uncertainty.candidates
                ? t("notes.speaker.reason.closeMatch", {
                    first: segment.uncertainty.candidates[0],
                    second: segment.uncertainty.candidates[1],
                  })
                : t(`notes.speaker.reason.${segment.uncertainty.reason}`)}
            </span>
          )}
          {segment.changedAfterFinal && segment.uncertainty?.reason !== "changed_after_final" && (
            <span>{t("notes.speaker.reason.changed_after_final")}</span>
          )}
          {segment.machineReason === "approved_voice" && (
            <span>{t("notes.speaker.reason.approved_voice")}</span>
          )}
          {rowChangeNote && (
            <span dir="auto" className="min-w-0 break-words">
              {rowChangeNote}
            </span>
          )}
          {onUndoCorrection && rowAction?.undoAvailable && (
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onUndoCorrection(rowAction.id)}
            >
              {t("notes.speaker.restore")}
            </button>
          )}
          {onUndoCorrection && rowAction && !rowAction.undoAvailable && (
            <span>
              {rowAction.unavailableReason
                ? t(`people.errors.${rowAction.unavailableReason}`, {
                    defaultValue: t("people.actionError"),
                  })
                : t("people.undoOrder")}
            </span>
          )}
        </div>
      )}
      <div className="relative max-w-[80%]">
        <div
          className={cn(
            "px-3 py-1.5 cursor-default transition-colors",
            "text-[13px] leading-relaxed",
            selfSide
              ? cn(
                  "bg-primary/90 text-primary-foreground",
                  sameSpeaker ? "rounded-lg rounded-ss-sm" : "rounded-lg rounded-es-sm"
                )
              : cn(
                  "bg-surface-2 border border-border/70 text-foreground",
                  sameSpeaker ? "rounded-lg rounded-se-sm" : "rounded-lg rounded-ee-sm",
                  isSystemSpeaker && cn("border-s-2", SPEAKER_BORDER_COLORS[colorIdx])
                ),
            isSelected && "ring-2 ring-primary/60"
          )}
        >
          <span dir="auto">{segment.text}</span>
        </div>
        {audioState && (
          <div className="mt-1 px-1 text-[11px] text-muted-foreground">
            {audioUnavailableReason ? (
              <span>{t(`meetingAudio.${audioUnavailableReason}`)}</span>
            ) : (audioState === "complete" ||
                audioState === "recording" ||
                audioState === "incomplete") &&
              (segment.audioSpan || segment.timestamp != null) &&
              onPlayAudio ? (
              <button
                type="button"
                onClick={() => onPlayAudio(segment)}
                className="rounded px-1 py-0.5 underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={
                  t(playing ? "meetingAudio.pause" : "meetingAudio.play") + ": " + segment.text
                }
              >
                {t(playing ? "meetingAudio.pause" : "meetingAudio.play")}
                {(!segment.wordTimings?.length || !segment.audioSpan) && (
                  <span className="ms-1">
                    ·{" "}
                    {t(
                      segment.speechStart == null
                        ? "meetingAudio.noOnset"
                        : "meetingAudio.approximate"
                    )}
                  </span>
                )}
              </button>
            ) : (
              <span>
                {t(
                  `meetingAudio.${
                    ["expired", "deleted", "evicted", "incomplete"].includes(audioState)
                      ? audioState
                      : audioState === "key_unavailable"
                        ? "keyUnavailable"
                        : "unavailable"
                  }`
                )}
              </span>
            )}
          </div>
        )}
        {sourceChips?.map((row) => (
          <button
            key={row.id}
            type="button"
            title={row.text}
            onClick={onOpenSourceTodos}
            className={`mt-1 flex max-w-full items-center gap-1.5 rounded-full border border-border/70 bg-muted/50 px-2 py-0.5 text-start text-[11px] hover:bg-muted ${groupFor(row) === "overdue" ? "text-destructive" : "text-muted-foreground"}`}
          >
            <span
              aria-hidden="true"
              className={`size-1.5 shrink-0 rounded-full ${groupFor(row) === "overdue" ? "bg-destructive" : "bg-primary"}`}
            />
            <span className="min-w-0 truncate">{row.text}</span>
          </button>
        ))}
        {selectable && (
          <SelectCheckbox
            isSelected={isSelected}
            onToggle={() => onToggleSelect?.(segment.id)}
            className={cn("absolute top-1.5", selfSide ? "-start-6" : "-end-6")}
          />
        )}
      </div>
    </div>
  );
});

interface MeetingTranscriptChatProps {
  segments: TranscriptSegment[];
  speakerActionLog?: string | null;
  readOnly?: boolean;
  noteId?: number;
  micPartial?: string;
  systemPartial?: string;
  systemPartialSpeakerId?: string | null;
  systemPartialSpeakerName?: string | null;
  speakerMappings?: Record<string, string>;
  speakerProfiles?: SpeakerProfileLite[];
  participants?: Array<{ email: string; displayName: string | null }>;
  selectedSegmentIds?: Set<string>;
  isRecording?: boolean;
  isDiarizing?: boolean;
  sessionDiarizationEnabled?: boolean;
  sessionExpectedCount?: number | null;
  userTouchedStepper?: boolean;
  onSetSessionDiarizationEnabled?: (enabled: boolean) => void;
  onSetSessionExpectedCount?: (count: number) => void;
  onAssignSpeakerScope?: (
    scope: "row" | "selected" | "cluster",
    rowId: string,
    name: string | null,
    profileId?: number,
    email?: string | null
  ) => void;
  onSplitCluster?: (rowId: string) => void;
  onUndoCorrection?: (id: string) => void;
  onMapSpeaker?: (
    speakerId: string,
    displayName: string,
    email?: string | null,
    profileId?: number
  ) => void;
  onConfirmSuggestion?: (speakerId: string, suggestedName: string, profileId: number) => void;
  onDismissSuggestion?: (speakerId: string) => void;
  onAttachSpeakerEmail?: (profileId: number, email: string | null) => void;
  onToggleSelect?: (segmentId: string) => void;
  reviewOnly?: boolean;
  contentClassName?: string;
  focusRowId?: string;
}

export function MeetingTranscriptChat({
  segments: providedSegments,
  speakerActionLog,
  readOnly = false,
  noteId,
  micPartial,
  systemPartial,
  systemPartialSpeakerId,
  systemPartialSpeakerName,
  speakerMappings,
  speakerProfiles,
  participants,
  selectedSegmentIds,
  isRecording,
  isDiarizing,
  sessionDiarizationEnabled = true,
  sessionExpectedCount = null,
  userTouchedStepper = false,
  onSetSessionDiarizationEnabled,
  onSetSessionExpectedCount,
  onMapSpeaker,
  onAssignSpeakerScope,
  onSplitCluster,
  onUndoCorrection,
  onConfirmSuggestion,
  onDismissSuggestion,
  onAttachSpeakerEmail,
  onToggleSelect,
  reviewOnly = false,
  focusRowId,
  contentClassName,
}: MeetingTranscriptChatProps) {
  const segments = useMemo(
    () => normalizeTranscriptSegments(projectSpeakerActions(providedSegments, speakerActionLog)),
    [providedSegments, speakerActionLog]
  );
  const { t } = useTranslation();
  const [audioStatus, setAudioStatus] = useState<{
    state: string;
    reason?: string | null;
    bytes: number;
    startedAt?: number;
    recordingId?: string | number;
    tracks?: Partial<
      Record<"mic" | "system", { chunks: Array<{ startSample: number; sampleCount: number }> }>
    >;
    keep?: boolean;
  } | null>(null);
  const [audioUsage, setAudioUsage] = useState<{
    usedBytes: number;
    budgetBytes: number;
    days: 3 | 7 | 30;
    evictions: Array<{ noteId: number; title: string; at: number }>;
  } | null>(null);
  const [audioMessage, setAudioMessage] = useState("");
  const [playingRowId, setPlayingRowId] = useState<string | null>(null);
  const playbackRef = useRef<MeetingAudioPlayback | null>(null);
  if (!playbackRef.current) playbackRef.current = new MeetingAudioPlayback();
  const statusRequestRef = useRef(0);
  const refreshAudio = useCallback(() => {
    if (noteId == null) return;
    const request = ++statusRequestRef.current;
    void window.electronAPI?.meetingAudioStatus?.(noteId).then((status) => {
      if (request === statusRequestRef.current) setAudioStatus(status);
    });
    void window.electronAPI?.meetingAudioUsage?.().then((usage) => setAudioUsage(usage));
  }, [noteId]);
  useEffect(() => {
    refreshAudio();
    const timer = window.setInterval(refreshAudio, isRecording ? 5000 : 30000);
    return () => window.clearInterval(timer);
  }, [refreshAudio, isRecording]);
  useEffect(
    () => () => {
      playbackRef.current?.invalidate();
      statusRequestRef.current++;
    },
    [noteId]
  );
  useEffect(() => {
    if (
      ["deleted", "expired", "evicted", "unavailable", "key_unavailable"].includes(
        audioStatus?.state || ""
      )
    ) {
      playbackRef.current?.invalidate();
      setPlayingRowId(null);
    }
  }, [audioStatus?.state]);
  useEffect(
    () =>
      window.electronAPI?.onMeetingAudioChanged?.((change) => {
        if (change.noteId !== noteId) return;
        playbackRef.current?.invalidate();
        statusRequestRef.current++;
        setPlayingRowId(null);
        setAudioStatus({ state: change.state, bytes: 0 });
        refreshAudio();
      }),
    [noteId, refreshAudio]
  );
  const playAudio = useCallback(
    async (segment: TranscriptSegment) => {
      if (
        noteId == null ||
        (!segment.audioSpan && (segment.timestamp == null || audioStatus?.startedAt == null))
      )
        return;
      if (playingRowId === segment.id) {
        playbackRef.current?.invalidate();
        setPlayingRowId(null);
        return;
      }
      try {
        const request = playbackRef.current!.request();
        const { from, to, track } = playbackRange(
          segment,
          segments,
          audioStatus?.recordingId ?? noteId,
          audioStatus?.startedAt,
          audioStatus?.tracks
        );
        const response = await window.electronAPI?.meetingAudioSpan?.(noteId, track, from, to);
        if (!playbackRef.current?.isCurrent(request)) return;
        if (!response?.wav) {
          setAudioMessage(
            t(
              `meetingAudio.${response?.state === "not_flushed" ? "notFlushed" : response?.state === "gap" ? "gap" : "unavailable"}`
            )
          );
          refreshAudio();
          return;
        }
        const binary = atob(response.wav);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
        const player = new Audio(url);
        if (!playbackRef.current?.install(request, url, player)) return;
        player.onended = () => {
          if (playbackRef.current?.isCurrent(request)) setPlayingRowId(null);
        };
        await player.play();
        if (!playbackRef.current?.isCurrent(request)) return;
        setPlayingRowId(segment.id);
        setAudioMessage(response.partial ? t("meetingAudio.partial") : "");
      } catch (error) {
        setAudioMessage(
          t(
            error instanceof PlaybackUnavailableError
              ? `meetingAudio.${error.reason}`
              : "meetingAudio.unavailable"
          )
        );
      }
    },
    [noteId, audioStatus, playingRowId, refreshAudio, t, segments]
  );
  const deleteAudio = useCallback(async () => {
    if (noteId == null || !audioStatus) return;
    const size = `${new Intl.NumberFormat().format(audioStatus.bytes)} B`;
    if (!window.confirm(t("meetingAudio.confirmDelete", { size }))) return;
    playbackRef.current?.invalidate();
    statusRequestRef.current++;
    setPlayingRowId(null);
    try {
      const result = await window.electronAPI?.meetingAudioDelete?.(noteId);
      if (result?.state !== "deleted") setAudioMessage(t("meetingAudio.unavailable"));
    } catch {
      setAudioMessage(t("meetingAudio.unavailable"));
    }
    refreshAudio();
  }, [noteId, audioStatus, refreshAudio, t]);
  const [sourceChips, setSourceChips] = useState<{ noteId: number; rows: Commitment[] } | null>(
    null
  );
  useEffect(() => {
    if (noteId == null) {
      setSourceChips(null);
      return;
    }
    let active = true;
    const refresh = () => {
      const request =
        typeof window !== "undefined"
          ? window.electronAPI?.commitmentsForNote?.(noteId)
          : undefined;
      if (!request) {
        if (active) setSourceChips({ noteId, rows: [] });
        return;
      }
      void request
        .then((rows) => {
          if (active) setSourceChips({ noteId, rows });
        })
        .catch(() => {
          if (active) setSourceChips({ noteId, rows: [] });
        });
    };
    refresh();
    const off =
      typeof window !== "undefined"
        ? window.electronAPI?.onCommitmentsUpdated?.(refresh)
        : undefined;
    return () => {
      active = false;
      off?.();
    };
  }, [noteId]);
  const chipsByIndex = useMemo(
    () => sourceChipsByIndex(sourceChips && sourceChips.noteId === noteId ? sourceChips.rows : []),
    [sourceChips, noteId]
  );
  const openSourceTodos = useCallback(() => {
    if (noteId != null && typeof window !== "undefined")
      void window.electronAPI?.commitmentsOpenTodos?.({ kind: "note", value: String(noteId) });
  }, [noteId]);
  const hasContent = segments.length > 0 || Boolean(micPartial) || Boolean(systemPartial);
  const reviewCount = segments.filter(
    (segment) => segment.uncertainty || segment.quarantinedCorrections?.length
  ).length;
  const shownIndexes = useMemo(() => {
    if (!reviewOnly) return segments.map((_, index) => index);
    const indexes = new Set<number>();
    segments.forEach((segment, index) => {
      if (!segment.uncertainty && !segment.quarantinedCorrections?.length) return;
      if (index > 0) indexes.add(index - 1);
      indexes.add(index);
      if (index + 1 < segments.length) indexes.add(index + 1);
    });
    return [...indexes].sort((a, b) => a - b);
  }, [segments, reviewOnly]);
  // The scroller mounts only once content exists, and a recording opens with
  // partials before its first final segment — the follow effect must re-run on
  // that mount too, or it runs against a null node and never attaches its
  // resize observer.
  const followDep = useMemo(() => ({ segments, hasContent }), [segments, hasContent]);
  const {
    scrollRef,
    handleScroll,
    handleWheel,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  } = useStickToBottom<HTMLDivElement>(followDep);

  // Rows are keyed by segment id, not index: segments are inserted by timestamp
  // and retracted mid-list, which would misalign an index-keyed size cache.
  const virtualizer = useVirtualizer({
    count: shownIndexes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    getItemKey: (index) => segments[shownIndexes[index]].id,
    initialRect: INITIAL_VIEWPORT_RECT,
    overscan: 8,
  });
  const totalSize = virtualizer.getTotalSize();
  useEffect(() => {
    if (!focusRowId) return;
    const index = shownIndexes.findIndex((i) => segments[i]?.id === focusRowId);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: "center" });
    const timer = window.setTimeout(
      () =>
        document
          .querySelector<HTMLElement>(`[data-speaker-row-id="${CSS.escape(focusRowId)}"]`)
          ?.focus(),
      80
    );
    return () => window.clearTimeout(timer);
  }, [focusRowId, shownIndexes, segments, virtualizer]);

  const systemPartialSpeakerLabel =
    systemPartialSpeakerName ||
    (systemPartialSpeakerId
      ? t("notes.speaker.unknownNumber", { n: getSpeakerNumber(systemPartialSpeakerId) })
      : undefined);
  const systemPartialSpeakerState = systemPartialSpeakerId
    ? systemPartialSpeakerName
      ? "confirmed"
      : "provisional"
    : undefined;

  // Per-segment derivations hoisted out of the row map: rows receive them as
  // stable props, so partial ticks (which change neither input) skip every row.
  const youLabel = t("notes.speaker.you");
  const rowMeta = useMemo(
    () =>
      segments.map((segment) => ({
        key: getEffectiveSpeakerKey(segment, speakerMappings),
        activeName: resolveSegmentSpeakerName(segment, speakerMappings),
        selfSide: isSelfSideSegment(segment, speakerMappings, youLabel),
      })),
    [segments, speakerMappings, youLabel]
  );

  const colorByKey = useMemo(() => {
    const map = new Map<string, number>();
    let nextIdx = 0;
    segments.forEach((segment, i) => {
      if (segment.source === "mic" && !segment.speaker) return;
      // Bubbles on the user's side aren't colored, so they take no slot.
      if (rowMeta[i].selfSide) return;
      const key = rowMeta[i].key;
      if (!map.has(key)) {
        map.set(key, nextIdx % SPEAKER_BORDER_COLORS.length);
        nextIdx += 1;
      }
    });
    return map;
  }, [segments, rowMeta]);

  // First profile with an id per display name — mirrors the .find() each row did.
  const profilesByName = useMemo(() => {
    const map = new Map<string, SpeakerProfileLite>();
    for (const profile of speakerProfiles ?? []) {
      if (profile.id != null && !map.has(profile.display_name)) {
        map.set(profile.display_name, profile);
      }
    }
    return map;
  }, [speakerProfiles]);

  if (!hasContent) {
    return (
      <div className="h-full flex flex-col">
        {audioStatus && audioStatus.state !== "unavailable" && (
          <div className="px-4 py-2 text-xs text-muted-foreground" role="status">
            {t(
              `meetingAudio.${
                ["expired", "deleted", "evicted", "incomplete"].includes(audioStatus.state)
                  ? audioStatus.state
                  : audioStatus.state === "key_unavailable"
                    ? "keyUnavailable"
                    : "storage"
              }`,
              {
                used: ((audioUsage?.usedBytes || 0) / 1_000_000).toFixed(3),
                budget: ((audioUsage?.budgetBytes || 0) / 1_000_000).toFixed(3),
              }
            )}
            {audioUsage && readOnly && (
              <span className="ms-2">{t("meetingAudio.readOnlyPolicy")}</span>
            )}
            {!readOnly &&
              (audioStatus.state === "complete" || audioStatus.state === "incomplete") && (
                <button
                  type="button"
                  onClick={() => void deleteAudio()}
                  className="ms-2 underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t("meetingAudio.delete")}
                </button>
              )}
          </div>
        )}
        <div className="flex-1 flex items-center justify-center px-5">
          <p className="text-xs text-muted-foreground/70 select-none">
            {t("notes.editor.conversationWillAppear")}
          </p>
        </div>
      </div>
    );
  }

  const showAssumedHint =
    !isDiarizing &&
    sessionDiarizationEnabled &&
    sessionExpectedCount == null &&
    !(participants && participants.length > 0) &&
    !userTouchedStepper;

  return (
    <div className="h-full flex flex-col">
      {audioStatus && (
        <div
          className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-1 text-[11px] text-muted-foreground"
          role="status"
        >
          {audioUsage && (
            <span>
              {t("meetingAudio.storage", {
                used: (audioUsage.usedBytes / 1_000_000).toFixed(3),
                budget: (audioUsage.budgetBytes / 1_000_000).toFixed(3),
              })}
            </span>
          )}
          {(audioStatus.state === "incomplete" || audioStatus.state === "key_unavailable") && (
            <span>
              {audioStatus.reason?.includes("key")
                ? t("meetingAudio.keyUnavailable")
                : t("meetingAudio.incomplete")}
            </span>
          )}
          {audioUsage && readOnly && <span>{t("meetingAudio.readOnlyPolicy")}</span>}
          {audioUsage && !readOnly && (
            <>
              <span className="flex items-center gap-1">
                {t("meetingAudio.retention")}
                <Select
                  value={String(audioUsage.days)}
                  onValueChange={(value) => {
                    void window.electronAPI
                      ?.meetingAudioSetPolicy?.({
                        days: Number(value) as 3 | 7 | 30,
                        budgetBytes: audioUsage.budgetBytes,
                      })
                      ?.then(refreshAudio)
                      .catch(() => setAudioMessage(t("meetingAudio.unavailable")));
                  }}
                >
                  <SelectTrigger
                    aria-label={t("meetingAudio.retention")}
                    className="h-8 w-auto gap-2"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[3, 7, 30].map((days) => (
                      <SelectItem key={days} value={String(days)}>
                        {days} {t("meetingAudio.days")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </span>
              <span className="flex items-center gap-1">
                {t("meetingAudio.budget")}
                <Select
                  value={String(audioUsage.budgetBytes)}
                  onValueChange={(value) => {
                    void window.electronAPI
                      ?.meetingAudioSetPolicy?.({
                        days: audioUsage.days,
                        budgetBytes: Number(value),
                      })
                      ?.then(refreshAudio)
                      .catch(() => setAudioMessage(t("meetingAudio.unavailable")));
                  }}
                >
                  <SelectTrigger aria-label={t("meetingAudio.budget")} className="h-8 w-auto gap-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[500_000_000, 2 * 1024 * 1024 * 1024, 10_000_000_000].map((bytes) => (
                      <SelectItem key={bytes} value={String(bytes)}>
                        {(bytes / 1_000_000_000).toFixed(1)} GB
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </span>
              {audioUsage.evictions.length > 0 && (
                <span>
                  {t("meetingAudio.evictedNotes", {
                    titles: audioUsage.evictions
                      .slice(0, 3)
                      .map((item) => item.title)
                      .join(", "),
                  })}
                </span>
              )}
            </>
          )}
          {!readOnly &&
            (audioStatus.state === "complete" ||
              audioStatus.state === "incomplete" ||
              audioStatus.state === "recording") && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    if (noteId != null)
                      void window.electronAPI
                        ?.meetingAudioSetKeep?.(noteId, !audioStatus.keep)
                        ?.then(refreshAudio)
                        .catch(() => setAudioMessage(t("meetingAudio.unavailable")));
                  }}
                  className="underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t(audioStatus.keep ? "meetingAudio.unkeep" : "meetingAudio.keep")}
                </button>
                {audioStatus.state !== "recording" && (
                  <button
                    type="button"
                    onClick={() => void deleteAudio()}
                    className="underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {t("meetingAudio.delete")}
                  </button>
                )}
              </>
            )}
          {noteId != null && (
            <button
              type="button"
              className="underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() =>
                void window.electronAPI
                  ?.exportMeetingCalibration?.(noteId)
                  .then((result) => {
                    if (result?.success)
                      setAudioMessage(
                        t("meetingAudio.calibrationExported", { folder: result.folder })
                      );
                    else if (!result?.canceled)
                      setAudioMessage(result?.error || t("meetingAudio.unavailable"));
                  })
                  .catch(() => setAudioMessage(t("meetingAudio.unavailable")))
              }
            >
              {t("meetingAudio.exportCalibration")}
            </button>
          )}
          {audioMessage && <span>{audioMessage}</span>}
        </div>
      )}
      {(isRecording || isDiarizing) && (
        <div className={cn("shrink-0 px-4 pt-2 mb-1.5", contentClassName)}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 rounded-lg border border-border/70 bg-surface-2/40 text-xs text-foreground">
            <div className="flex items-center gap-1.5 min-w-0">
              {isDiarizing ? (
                <Loader2 size={12} className="animate-spin text-muted-foreground shrink-0" />
              ) : (
                <Sparkles
                  size={12}
                  className={cn(
                    "shrink-0",
                    sessionDiarizationEnabled ? "text-primary" : "text-muted-foreground"
                  )}
                />
              )}
              <span className="truncate">
                {isDiarizing
                  ? t("notes.speaker.pill.finalizing")
                  : sessionDiarizationEnabled
                    ? t("notes.speaker.pill.identifying")
                    : t("notes.speaker.pill.notLabeled")}
              </span>
              {showAssumedHint && (
                <span className="text-muted-foreground truncate">
                  {t("notes.speaker.pill.assumedHint")}
                </span>
              )}
            </div>
            <div className="flex-1" />
            {!isDiarizing && sessionDiarizationEnabled && (
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">
                  {t("notes.speaker.pill.speakersLabel")}
                </span>
                <div className="flex items-center gap-0.5 rounded-md border border-border bg-surface-2/60">
                  <button
                    onClick={() => onSetSessionExpectedCount?.((sessionExpectedCount ?? 2) - 1)}
                    disabled={sessionExpectedCount == null || sessionExpectedCount <= 1}
                    className="px-1.5 py-0.5 rounded-s-md hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:opacity-30 disabled:pointer-events-none transition-colors"
                    aria-label={t("notes.speaker.pill.decAria")}
                  >
                    −
                  </button>
                  <span className="px-1.5 tabular-nums" aria-live="polite">
                    {sessionExpectedCount === 1
                      ? t("notes.speaker.pill.justYou")
                      : (sessionExpectedCount ?? t("notes.speaker.scope.unknown"))}
                  </span>
                  <button
                    onClick={() => onSetSessionExpectedCount?.((sessionExpectedCount ?? 1) + 1)}
                    disabled={
                      sessionExpectedCount != null && sessionExpectedCount >= MAX_SPEAKER_COUNT
                    }
                    className="px-1.5 py-0.5 rounded-e-md hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:opacity-30 disabled:pointer-events-none transition-colors"
                    aria-label={t("notes.speaker.pill.incAria")}
                  >
                    +
                  </button>
                </div>
              </div>
            )}
            {!isDiarizing && (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => onSetSessionDiarizationEnabled?.(!sessionDiarizationEnabled)}
                  className="text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:underline"
                  aria-label={t("notes.speaker.pill.toggleAria")}
                >
                  {t("notes.speaker.pill.labelToggle")}
                </button>
                <div className="scale-75 -my-1">
                  <Toggle
                    checked={sessionDiarizationEnabled}
                    onChange={(next) => onSetSessionDiarizationEnabled?.(next)}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className="flex-1 min-h-0 overflow-y-auto pt-2 agent-chat-scroll pb-[var(--floating-inset,96px)]"
      >
        <div className={cn("px-4", contentClassName)}>
          <div style={{ height: totalSize, width: "100%", position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const i = shownIndexes[virtualItem.index];
              const segment = segments[i];
              const { key, activeName, selfSide } = rowMeta[i];
              const isSystemSpeaker = !!segment.speaker && !selfSide;
              let audioUnavailableReason: "timebase" | "gap" | "track" | undefined;
              if (
                audioStatus?.tracks &&
                ["complete", "incomplete", "recording"].includes(audioStatus.state) &&
                noteId != null &&
                (segment.audioSpan || segment.timestamp != null)
              ) {
                try {
                  playbackRange(
                    segment,
                    segments,
                    audioStatus.recordingId ?? noteId,
                    audioStatus.startedAt,
                    audioStatus.tracks
                  );
                } catch (error) {
                  if (error instanceof PlaybackUnavailableError)
                    audioUnavailableReason = error.reason;
                }
              }
              return (
                <div
                  key={segment.id}
                  data-speaker-row-id={segment.id}
                  tabIndex={-1}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  className="pb-1.5 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:rounded-md"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <SegmentRow
                    segment={segment}
                    sourceChips={chipsByIndex.get(i)}
                    onOpenSourceTodos={noteId == null ? undefined : openSourceTodos}
                    selfSide={selfSide}
                    sameSpeaker={
                      i > 0 && rowMeta[i - 1].key === key && rowMeta[i - 1].selfSide === selfSide
                    }
                    isFirst={i === 0}
                    isNewest={i === segments.length - 1}
                    colorIdx={isSystemSpeaker ? (colorByKey.get(key) ?? 0) : 0}
                    isSelected={selectedSegmentIds?.has(segment.id) ?? false}
                    activeName={activeName}
                    matchedProfile={activeName ? profilesByName.get(activeName) : undefined}
                    speakerProfiles={speakerProfiles}
                    participants={participants}
                    onMapSpeaker={onMapSpeaker}
                    onAssignSpeakerScope={onAssignSpeakerScope}
                    onSplitCluster={onSplitCluster}
                    onUndoCorrection={onUndoCorrection}
                    selectedRowIds={selectedSegmentIds}
                    selectedClusterCount={
                      segments.filter(
                        (row) =>
                          row.speaker === segment.speaker &&
                          row.diarizationRunId === segment.diarizationRunId &&
                          selectedSegmentIds?.has(row.id)
                      ).length
                    }
                    clusterRowCount={
                      segments.filter(
                        (row) =>
                          row.speaker === segment.speaker &&
                          row.diarizationRunId === segment.diarizationRunId
                      ).length
                    }
                    onConfirmSuggestion={onConfirmSuggestion}
                    onDismissSuggestion={onDismissSuggestion}
                    onAttachSpeakerEmail={onAttachSpeakerEmail}
                    onToggleSelect={onToggleSelect}
                    t={t}
                    audioState={
                      audioStatus?.state === "unavailable" ? undefined : audioStatus?.state
                    }
                    audioUnavailableReason={audioUnavailableReason}
                    playing={playingRowId === segment.id}
                    onPlayAudio={
                      segment.audioSpan || audioStatus?.startedAt != null ? playAudio : undefined
                    }
                  />
                </div>
              );
            })}
          </div>

          <div className="flex flex-col gap-1.5">
            {[
              { text: micPartial, source: "mic" as const, speakerLabel: undefined },
              {
                text: systemPartial,
                source: "system" as const,
                speakerLabel: systemPartialSpeakerLabel,
              },
            ].map(
              ({ text, source, speakerLabel }) =>
                text && (
                  <PartialBubble
                    key={source}
                    text={text}
                    source={source}
                    speakerLabel={speakerLabel}
                    speakerState={source === "system" ? systemPartialSpeakerState : undefined}
                    t={t}
                  />
                )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
