type Pausable = { pause(): void };

type PlaybackRow = { id: string; source: "mic" | "system"; timestamp?: number | null;
  wordTimings?: Array<{ start: number; end: number }>;
  audioSpan?: { recordingId: string | number; trackId: "mic" | "system";
    startSample: number; endSample: number } };

// 40 ms covers word-timestamp rounding and a short consonant edge. It is
// deliberately smaller than an ordinary inter-turn gap.
export const PLAYBACK_MARGIN_SECONDS = 0.04;

export function playbackRange(row: PlaybackRow, rows: PlaybackRow[], recordingId: string | number,
  startedAt?: number): { from: number; to: number; track: "mic" | "system"; approximate: boolean } {
  const aligned = !!row.wordTimings?.length && row.audioSpan?.recordingId === recordingId;
  const position = row.timestamp != null && row.timestamp > 1000000000000
    ? (row.timestamp - (startedAt || 0)) / 1000
    : (row.timestamp ?? (row.audioSpan?.startSample ?? 0) / 24000);
  const start = aligned ? row.audioSpan!.startSample / 24000 : position;
  const end = aligned ? row.audioSpan!.endSample / 24000 : position + 2;
  const track = aligned ? row.audioSpan!.trackId : row.source;
  const index = rows.findIndex(candidate => candidate.id === row.id);
  const next = index < 0 ? [] : rows.slice(index + 1).filter(candidate => candidate.source === track);
  const nextStart = next.map(candidate => candidate.audioSpan?.recordingId === recordingId && candidate.wordTimings?.length
    ? candidate.audioSpan.startSample / 24000
    : candidate.timestamp != null && candidate.timestamp > 1000000000000
      ? (candidate.timestamp - (startedAt || 0)) / 1000 : candidate.timestamp)
    .find(value => value != null && Number.isFinite(value));
  const from = Math.max(0, Math.round((start - PLAYBACK_MARGIN_SECONDS) * 1000) / 1000);
  const to = Math.max(from, Math.min(end + PLAYBACK_MARGIN_SECONDS, nextStart ?? Infinity));
  return { from, to: Math.round(to * 1000) / 1000,
    track, approximate: !aligned };
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
