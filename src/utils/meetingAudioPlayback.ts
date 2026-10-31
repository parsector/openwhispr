type Pausable = { pause(): void };

type PlaybackRow = {
  id: string;
  source: "mic" | "system";
  timestamp?: number | null;
  speechStart?: number | null;
  speechEnd?: number | null;
  recordingId?: string | number;
  recordingOrigin?: number;
  timebase?: "epoch" | "recording";
  wordTimings?: Array<{ start: number; end: number }>;
  audioSpan?: {
    recordingId: string | number;
    trackId: "mic" | "system";
    startSample: number;
    endSample: number;
  };
};

// 40 ms covers word-timestamp rounding and a short consonant edge. It is
// deliberately smaller than an ordinary inter-turn gap.
export const PLAYBACK_MARGIN_SECONDS = 0.04;
const UNKNOWN_ONSET_WINDOW_SECONDS = 10;

export class PlaybackUnavailableError extends Error {
  constructor(readonly reason: "timebase" | "gap" | "track") {
    super(reason);
  }
}

function recordingSeconds(value: number | null | undefined, startedAt?: number): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value > 1000000000000 ? (startedAt != null ? (value - startedAt) / 1000 : null) : value;
}

export function playbackRange(
  row: PlaybackRow,
  rows: PlaybackRow[],
  recordingId: string | number,
  startedAt?: number,
  tracks?: Partial<
    Record<"mic" | "system", { chunks: Array<{ startSample: number; sampleCount: number }> }>
  >
): { from: number; to: number; track: "mic" | "system"; approximate: boolean } {
  if (
    (row.recordingId != null && row.recordingId !== recordingId) ||
    (row.audioSpan?.recordingId != null && row.audioSpan.recordingId !== recordingId) ||
    (row.recordingOrigin != null && row.recordingOrigin !== startedAt) ||
    (row.timebase === "epoch" && row.timestamp != null && row.timestamp < 1000000000000) ||
    (row.timebase === "recording" &&
      (row.recordingId == null || (row.timestamp != null && row.timestamp > 1000000000000))) ||
    (row.timebase == null &&
      startedAt != null &&
      row.timestamp != null &&
      row.timestamp < 1000000000000 &&
      !row.audioSpan)
  )
    throw new PlaybackUnavailableError("timebase");
  if (row.audioSpan && row.audioSpan.trackId !== row.source)
    throw new PlaybackUnavailableError("track");
  const aligned = !!row.wordTimings?.length && row.audioSpan?.recordingId === recordingId;
  const completion = recordingSeconds(row.timestamp, startedAt);
  const onset = recordingSeconds(row.speechStart, startedAt);
  const speechEnd = recordingSeconds(row.speechEnd, startedAt);
  const start = aligned
    ? row.audioSpan!.startSample / 24000
    : (onset ?? Math.max(0, (completion ?? 0) - UNKNOWN_ONSET_WINDOW_SECONDS));
  const end = aligned
    ? row.audioSpan!.endSample / 24000
    : (speechEnd ?? completion ?? start + UNKNOWN_ONSET_WINDOW_SECONDS);
  const track = row.source;
  const index = rows.findIndex((candidate) => candidate.id === row.id);
  const next =
    index < 0
      ? []
      : rows
          .slice(index + 1)
          .filter(
            (candidate) =>
              candidate.source === track &&
              (candidate.recordingId == null || candidate.recordingId === recordingId)
          );
  const nextStart = next
    .map((candidate) =>
      candidate.audioSpan?.recordingId === recordingId &&
      candidate.audioSpan.trackId === track &&
      candidate.wordTimings?.length
        ? candidate.audioSpan.startSample / 24000
        : recordingSeconds(candidate.speechStart, startedAt)
    )
    .find((value) => value != null && Number.isFinite(value));
  const from = Math.max(0, Math.round((start - PLAYBACK_MARGIN_SECONDS) * 1000) / 1000);
  let to = Math.max(from, Math.min(end + PLAYBACK_MARGIN_SECONDS, nextStart ?? Infinity));
  if (tracks) {
    const chunks = tracks[track]?.chunks || [];
    const regions: Array<{ from: number; to: number }> = [];
    for (const chunk of chunks) {
      const chunkFrom = chunk.startSample / 24000;
      const chunkTo = (chunk.startSample + chunk.sampleCount) / 24000;
      const last = regions.at(-1);
      if (last && chunkFrom <= last.to) last.to = Math.max(last.to, chunkTo);
      else regions.push({ from: chunkFrom, to: chunkTo });
    }
    const anchor = aligned ? start : (onset ?? completion ?? start);
    const containing = regions.find((region) => region.from <= anchor && region.to > anchor);
    if (!containing) throw new PlaybackUnavailableError("gap");
    // A row may be adjacent to a stop/restart boundary. Do not return audio
    // across that boundary, or substitute the next session's words.
    const lower = containing.from;
    const upper = containing.to;
    const boundedFrom = Math.max(from, lower);
    to = Math.min(to, upper);
    if (to <= boundedFrom) throw new PlaybackUnavailableError("gap");
    return {
      from: Math.round(boundedFrom * 1000) / 1000,
      to: Math.round(to * 1000) / 1000,
      track,
      approximate: !aligned,
    };
  }
  return { from, to: Math.round(to * 1000) / 1000, track, approximate: !aligned };
}

// A response owns its object URL only while its request generation is current.
export class MeetingAudioPlayback {
  private generation = 0;
  private url: string | null = null;
  player: Pausable | null = null;

  constructor(private readonly revoke: (url: string) => void = URL.revokeObjectURL) {}

  request(): number {
    this.invalidate();
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  install(generation: number, url: string, player: Pausable): boolean {
    if (!this.isCurrent(generation)) {
      player.pause();
      this.revoke(url);
      return false;
    }
    this.url = url;
    this.player = player;
    return true;
  }

  invalidate(): void {
    this.generation++;
    this.player?.pause();
    if (this.url) this.revoke(this.url);
    this.player = null;
    this.url = null;
  }
}
