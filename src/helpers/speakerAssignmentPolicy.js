const { resolveAutomaticSpeaker } = require("./automaticSpeakerAttribution");
const { humanProtected } = require("./speakerRosterPolicy");
const SPEAKER_STATUS = Object.freeze({
  PROVISIONAL: "provisional",
  CONFIRMED: "confirmed",
  SUGGESTED: "suggested",
  LOCKED: "locked",
});

function canonicalizeSpeakerStatus(status, segment = null) {
  if (humanProtected(segment)) {
    return SPEAKER_STATUS.LOCKED;
  }

  switch (status) {
    case SPEAKER_STATUS.PROVISIONAL:
    case SPEAKER_STATUS.CONFIRMED:
    case SPEAKER_STATUS.SUGGESTED:
    case SPEAKER_STATUS.LOCKED:
      return status;
    case "user_locked":
      return SPEAKER_STATUS.LOCKED;
    case "suggested_profile":
      return SPEAKER_STATUS.SUGGESTED;
    case "uncertain_overlap":
      return SPEAKER_STATUS.PROVISIONAL;
    default:
      return undefined;
  }
}

function isSpeakerLocked(segment) {
  return canonicalizeSpeakerStatus(segment?.speakerStatus, segment) === SPEAKER_STATUS.LOCKED;
}

function canAutoRelabelSpeaker(segment) {
  return (
    !isSpeakerLocked(segment) &&
    !["too_short", "close_match", "not_sure", "overlapping_speech"].includes(
      segment?.uncertainty?.reason
    )
  );
}

function applySpeakerUpdate(segment, patch, status, scope) {
  if (!canAutoRelabelSpeaker(segment)) {
    if (!isSpeakerLocked(segment)) return segment;
    segment.speakerStatus = SPEAKER_STATUS.LOCKED;
    segment.speakerLocked = true;
    segment.speakerLockSource = segment.speakerLockSource || "user";
    return segment;
  }

  Object.assign(
    segment,
    resolveAutomaticSpeaker(segment, segment.speakerDecision, scope, {
      ...segment,
      ...patch,
      speakerStatus: status,
    })
  );
  return segment;
}

function applyProvisionalSpeaker(segment, patch = {}, scope) {
  return applySpeakerUpdate(segment, patch, SPEAKER_STATUS.PROVISIONAL, scope);
}

function applyConfirmedSpeaker(segment, patch = {}, scope) {
  return applySpeakerUpdate(segment, patch, SPEAKER_STATUS.CONFIRMED, scope);
}

function applySuggestedSpeaker(segment, patch = {}, scope) {
  if (!canAutoRelabelSpeaker(segment)) {
    return segment;
  }

  return applySpeakerUpdate(segment, patch, SPEAKER_STATUS.SUGGESTED, scope);
}

module.exports = {
  SPEAKER_STATUS,
  canonicalizeSpeakerStatus,
  isSpeakerLocked,
  canAutoRelabelSpeaker,
  applyProvisionalSpeaker,
  applyConfirmedSpeaker,
  applySuggestedSpeaker,
};
