type ResolvedMeetingAudioSpan = {
  from: number;
  to: number;
  start: number;
  end: number;
  track: "mic" | "system";
  approximate: boolean;
  reason: null;
};

type UnavailableMeetingAudioSpan = {
  reason: "timebase" | "track_mismatch" | "gap" | "outside_recorded_range";
  start?: number;
  end?: number;
  track?: "mic" | "system";
  approximate?: boolean;
};

export function resolveMeetingAudioSpan(
  row: object,
  rows: object[],
  recordingId: string | number,
  startedAt?: number,
  tracks?: object
): ResolvedMeetingAudioSpan | UnavailableMeetingAudioSpan;
