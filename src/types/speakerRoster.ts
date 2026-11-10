export interface SpeakerDecision {
  candidateSetStatus: "recorded" | "not_recorded";
  acousticEvaluation?: "evaluated" | "not_evaluated";
  decisionId: string;
  runId: string;
  noteId: number | null;
  rosterRevision: number;
  linkedEventId: string | null;
  source: string;
  revision: string;
  rawRoster: unknown;
  roster: Array<Record<string, unknown>>;
  unrestricted: boolean;
  scopeFailure: string | null;
  eligibleProfileIds: number[];
  policyVersion: number;
  acceptedProfileId: number | null;
  acceptedIdentity?: { email: string | null } | null;
  acousticWinnerProfileId: number | null;
  acousticRunnerUpProfileId?: number | null;
  effectiveThresholds?: Record<string, number> | null;
  cohortSelection?: {
    profileId: number | null;
    raw: number;
    normalized: number;
    rawFloor: number;
    accepted: boolean;
  };
  origin: "machine";
  path: string;
  scores: Record<string, number> | null;
  rejectionReason: string | null;
  profileFingerprints: Array<{ id: number; fingerprint: string | null }>;
  modelFingerprint: string | null;
  evaluation?: {
    rowId: string;
    previousDecisionId: string;
    audioContentHash: string;
    audioSpan?: {
      recordingId: string | number;
      trackId: string;
      startSample: number;
      endSample: number;
    };
    revision: string;
    rosterRevision: number;
    profileFingerprint?: string;
    audioTransition?: {
      kind: "replacement" | "reupload";
      parentRecordingId: string | number;
      previousAudioSpan: {
        recordingId: string | number;
        trackId: string;
        startSample: number;
        endSample: number;
      };
      canonicalHashMatched: boolean;
    };
  };
  previousDecision?: SpeakerDecision | null;
  rawDecision?: SpeakerDecision;
}
