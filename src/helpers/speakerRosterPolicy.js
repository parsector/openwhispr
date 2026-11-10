// NULL and [] both declare unrestricted naming. Calendar metadata cannot
// override the note. Missing context and malformed JSON always fail closed.
// Shared, read-only policy. A roster vetoes the acoustic winner; it never
// changes the ranking or supplies a runner-up. Legacy name links are not identity.
export const SPEAKER_ROSTER_POLICY_VERSION = 1;
export const normalizedEmail = (value) =>
  typeof value === "string" && /^[^\s@]+@[^\s@]+$/.test(value.trim())
    ? value.trim().toLowerCase()
    : null;

export function resolveSpeakerRoster(note, event, profiles = []) {
  let source = "none";
  let rawRoster = null;
  let roster = [];
  let failure = null;
  if (note?.id != null && !note.deleted_at) {
    if (note.participants != null) {
      source = "note";
      rawRoster = note.participants;
    }
    if (rawRoster != null) {
      try {
        const parsed = typeof rawRoster === "string" ? JSON.parse(rawRoster) : rawRoster;
        if (
          !Array.isArray(parsed) ||
          parsed.some((p) => !p || typeof p !== "object" || Array.isArray(p))
        )
          throw Error("malformed_roster");
        roster = JSON.parse(JSON.stringify(parsed));
      } catch {
        failure = "malformed_roster";
      }
    }
  } else failure = "note_missing";
  const unrestricted = !failure && roster.length === 0;
  const eligibleProfileIds = new Set(unrestricted ? profiles.map((p) => p.id) : []);
  for (const participant of roster) {
    const email = normalizedEmail(participant.email);
    if (!email) continue;
    const matches = profiles.filter((p) => normalizedEmail(p.email) === email);
    if (matches.length === 1) eligibleProfileIds.add(matches[0].id);
  }
  return {
    noteId: note?.id ?? null,
    rosterRevision: note?.speaker_roster_revision ?? 0,
    linkedEventId: note?.calendar_event_id || null,
    source,
    // Include raw data: malformed data cannot silently acquire a calendar roster.
    revision: JSON.stringify([
      note?.speaker_roster_revision ?? 0,
      source,
      rawRoster,
      failure,
      unrestricted ? null : [...eligibleProfileIds].sort((a, b) => a - b),
    ]),
    rawRoster: rawRoster == null ? null : JSON.parse(JSON.stringify(rawRoster)),
    roster,
    unrestricted,
    eligibleProfileIds: [...eligibleProfileIds],
    failure,
  };
}

export const eligible = (scope, profileId) =>
  profileId != null && !scope?.failure && !!scope?.eligibleProfileIds?.includes(profileId);

export const humanProtected = (row) =>
  row?.speakerAssignment?.origin === "human" ||
  !!row?.speakerLocked ||
  row?.speakerLockSource === "user" ||
  ["locked", "user_locked"].includes(row?.speakerStatus);

export function mayAutoName(
  row,
  profile,
  scope,
  { acousticAccepted = false, currentRevision = scope?.revision } = {}
) {
  return (
    !humanProtected(row) &&
    eligible(scope, profile?.id) &&
    profile?.voice_usable === 1 &&
    !!profile?.embedding?.length &&
    acousticAccepted &&
    currentRevision === scope?.revision &&
    !row?.overlap &&
    ![
      "too_short",
      "close_match",
      "not_sure",
      "overlapping_speech",
      "possible_mixed_speakers",
    ].includes(row?.uncertainty?.reason)
  );
}

// Consumers must not fall back to a cluster mapping after a recorded veto.
// Historical rows keep their original semantics; absence is never fabricated evidence.
export function recordedNameAllowed(row) {
  if (humanProtected(row)) return true;
  if (!row?.speakerDecision)
    return row?.speakerAssignment?.origin !== "machine" || row.speakerAssignment.accepted === true;
  const decision = row.speakerDecision;
  return (
    decision.acceptedProfileId != null &&
    eligible(decision, decision.acceptedProfileId) &&
    !decision.rejectionReason
  );
}

export function candidateSetEvidence(row) {
  return row?.speakerDecision || { candidateSetStatus: "not_recorded" };
}

// Renderer events can arrive after the edit notification, even before a row
// has been saved. Compare the note generation and declared snapshot directly.
export function decisionCurrentForNote(decision, note) {
  if (!decision || !note || decision.noteId !== note.id) return false;
  if ((note.speaker_roster_revision ?? 0) !== decision.rosterRevision) return false;
  if (note.participants != null)
    return decision.source === "note" && decision.rawRoster === note.participants;
  return decision.source !== "note";
}
