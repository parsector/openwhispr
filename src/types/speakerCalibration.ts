type ThresholdPolicy = { similarityFloor: number; runnerUpMargin: number };

type CalibrationReportBase = {
  version: 3;
  id: string;
  scope: { kind: "all" | "range"; from?: string; to?: string };
  policy: Record<string, number | null>;
  failedCriteria: string[];
  nextAction: string | null;
  criteriaGroups?: { unavailableInVersion: string[]; evidenceLimits: string[] };
  evidenceScope: {
    tuningSessions: string[];
    evaluationSessions: string[];
    evaluationSource: string | null;
  };
  validation: {
    rows: number;
    positives: number;
    negatives: number;
    accepted: number;
    right: number;
    wrong: number;
    refused: number;
    precision: number | null;
    correctNameCoverage: number | null;
    checks: Record<string, boolean>;
  };
  uncertainty: string[];
  evidence: {
    notes: number;
    reviewedRows: number;
    distinctPeople: number;
    machineClaims: number;
    exactClusters: number;
    calibrationRows: number;
    storedRows: number;
    exemplarRows?: number;
    savedExemplars?: number;
    timingProvenanceCounts?: Record<string, number>;
    fingerprintIntegrity?: Array<{
      noteId: number;
      rowId: string;
      exemplarId?: string;
      evidenceKey?: string;
      reason: string;
    }>;
    reconstructedRows: number;
    reviewedCandidates: number;
    consideredRows: number;
    rowBudget: number;
    noteBudget: number;
    selectedNotes: number;
    truncatedByRowBudget: boolean;
    placementCounts: { exact: number; approximate: number; unavailable: number };
    embeddingCounts: { embedded: number; refused: number };
    coverage: string;
    exclusionCounts: Record<string, number>;
    missingVectorDiagnostics: Array<{
      noteId: number;
      reason: string;
      cause: string | null;
      messageKey: string;
      clusters: number | null;
      vectorsWritten: number | null;
    }>;
    exclusions: Array<{ reason: string }>;
  };
  analyses: {
    calibration: {
      label: string;
      rows: number;
      winner: ThresholdPolicy & { right: number; wrong: number; refused: number };
      table: Array<ThresholdPolicy & { right: number; wrong: number; refused: number }>;
    };
  };
  support: Record<string, { status: string; method?: string; reason?: string }>;
};

export type SpeakerCalibrationReport = CalibrationReportBase &
  (
    | { resultType: "supported_recommendation"; recommended: ThresholdPolicy }
    | { resultType: "diagnostic_only"; recommended: Record<string, never> }
  );
