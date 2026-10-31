// Compare a recording's voices against the same set of profiles. A profile
// that resembles every voice in the room gets less credit than one distinctive
// to this cluster. The raw cosine remains the safety gate for automatic naming.
function rankProfiles(query, otherVoices, profiles, cosine) {
  const ranked = profiles.map(profile => {
    const raw = cosine(query, profile.embedding);
    const baseline = otherVoices.length
      ? otherVoices.reduce((sum, voice) => sum + cosine(voice, profile.embedding), 0) / otherVoices.length
      : 0;
    return { ...profile, raw, normalized: raw - baseline };
  });
  const rawBest = [...ranked].sort((a, b) => b.raw - a.raw)[0] || null;
  const cohortBest = otherVoices.length
    ? [...ranked].sort((a, b) => b.normalized - a.normalized)[0] || null
    : rawBest;
  return { rawBest, cohortBest, changed: !!rawBest && !!cohortBest && rawBest.id !== cohortBest.id };
}
module.exports = { rankProfiles };
