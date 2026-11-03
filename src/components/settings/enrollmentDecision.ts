type Api = typeof window.electronAPI;
type Candidate = Awaited<
  ReturnType<NonNullable<Api["listVoiceEnrollmentCandidates"]>>
>["candidates"][number];
type Sample = Awaited<ReturnType<NonNullable<Api["listVoiceEnrollmentSamples"]>>>[number];
type Reasons = Awaited<ReturnType<NonNullable<Api["listVoiceEnrollmentCandidates"]>>>["reasons"];

export async function saveEnrollmentDecision(
  candidate: Candidate,
  choice: "approve" | "reject",
  token: string,
  api: Pick<
    Api,
    | "decideVoiceEnrollmentCandidate"
    | "listVoiceEnrollmentCandidates"
    | "listVoiceEnrollmentSamples"
  >,
  candidates: Candidate[],
  samples: Sample[],
  refreshPeople: () => Promise<unknown>
): Promise<{
  committed: boolean;
  error: string;
  candidates: Candidate[];
  samples: Sample[];
  reasons?: Reasons;
  timingId?: string;
}> {
  let decision:
    | {
        success: boolean;
        error?: string;
        refreshFailed?: boolean;
        timingId?: string;
        offers?: { candidates: Candidate[]; reasons?: Reasons };
      }
    | undefined;
  try {
    decision = await api.decideVoiceEnrollmentCandidate?.(candidate.id, choice, token);
  } catch {
    return { committed: false, error: "ipc_failed", candidates, samples, timingId: undefined };
  }
  if (!decision?.success) {
    return {
      committed: false,
      error: decision?.error || "ipc_failed",
      candidates,
      samples,
      timingId: decision?.timingId,
    };
  }

  const committedCandidates = candidates.filter((item) => item.id !== candidate.id);
  const committedSamples =
    choice === "approve"
      ? [
          ...samples,
          {
            id: candidate.id,
            profileId: candidate.profileId,
            noteId: candidate.noteId,
            noteTitle: candidate.noteTitle,
            rowIds: candidate.rowIds,
            meetingDate: candidate.meetingDate,
            durationSeconds: candidate.durationSeconds,
            odd: false,
          },
        ]
      : samples;
  try {
    const [offers, savedSamples] = await Promise.all([
      decision.offers
        ? Promise.resolve(decision.offers)
        : api.listVoiceEnrollmentCandidates?.(candidate.profileId),
      api.listVoiceEnrollmentSamples?.(candidate.profileId),
    ]);
    if (!offers || !savedSamples) throw Error("refresh_failed");
    await refreshPeople();
    return {
      committed: true,
      error: decision.refreshFailed ? "refresh_failed" : "",
      candidates: offers.candidates,
      samples: savedSamples,
      reasons: offers.reasons,
      timingId: decision.timingId,
    };
  } catch {
    return {
      committed: true,
      error: "refresh_failed",
      candidates: decision?.offers?.candidates ?? committedCandidates,
      samples: committedSamples,
      timingId: decision?.timingId,
    };
  }
}
