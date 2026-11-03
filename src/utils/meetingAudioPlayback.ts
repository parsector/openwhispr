import { resolveMeetingAudioSpan } from "../helpers/meetingAudioSpan.mjs";

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

export const PLAYBACK_MARGIN_SECONDS = 0.04;

export class PlaybackUnavailableError extends Error {
  constructor(readonly reason: "timebase" | "gap" | "track") {
    super(reason);
  }
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
  const result = resolveMeetingAudioSpan(row, rows, recordingId, startedAt, tracks);
  if (!("from" in result)) {
    throw new PlaybackUnavailableError(
      result.reason === "track_mismatch"
        ? "track"
        : result.reason === "timebase"
          ? "timebase"
          : "gap"
    );
  }
  return { from: result.from, to: result.to, track: result.track, approximate: result.approximate };
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
