// Naming only changes the note mapping and live display label. Future voice
// enrollment must enter through an approved-exemplar path, never this API.
function setSpeakerNameMapping(
  databaseManager,
  liveSpeakerIdentifier,
  { noteId, speakerId, displayName, email = null, profileId = null }
) {
  const profiles = profileId == null ? databaseManager.getSpeakerProfiles?.() || [] : [];
  const normalizedEmail = email?.trim().toLowerCase();
  const existing =
    (normalizedEmail &&
      profiles.find((profile) => profile.email?.toLowerCase() === normalizedEmail)) ||
    profiles.find((profile) => profile.display_name === displayName);
  const resolvedProfileId = profileId ?? existing?.id ?? null;
  databaseManager.setSpeakerMapping(noteId, speakerId, resolvedProfileId, displayName);
  liveSpeakerIdentifier.mapSpeaker(speakerId, resolvedProfileId, displayName, noteId);
  return resolvedProfileId;
}

module.exports = { setSpeakerNameMapping };
