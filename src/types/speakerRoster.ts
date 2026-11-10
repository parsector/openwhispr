export interface SpeakerDecision {
  candidateSetStatus: "recorded";
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
  previousDecision?: SpeakerDecision | null;
  rawDecision?: SpeakerDecision;
}
