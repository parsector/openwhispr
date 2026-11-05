const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const expected = {
  exemplar_key_unavailable:
    "The audio encryption key is unavailable. No exemplar was saved. Restore access to the key and try again.",
  poor_audio: "This audio is unsuitable for a voice sample. Choose another span.",
  echo_audio: "This audio echoes the other track. Choose another span.",
  candidate_unavailable: "This candidate changed or was already reviewed. Refresh the list.",
  playback_required: "Listening confirmation expired or was replaced. Listen again.",
  span_mismatch: "This span no longer matches its recording. Choose another span.",
  person_or_meeting_changed: "The person or meeting changed. Refresh the list.",
  audio_unavailable: "This audio is no longer available. Choose another span.",
  persistence_failed:
    "The local database write failed. Your listening confirmation is still valid; try saving again.",
  database_busy:
    "The local database is busy. Your listening confirmation is still valid; try saving again.",
  constraint_failed:
    "The local database rejected this save. Your listening confirmation is still valid; try saving again.",
  already_approved: "This sample was already approved. Refresh the list.",
  refresh_failed:
    "The decision was saved, but a follow-up refresh failed. Reopen the list to see the latest samples.",
  ipc_failed:
    "Could not confirm whether the approval was saved. Refresh the list before trying again.",
  unavailable: "Voice enrolment is unavailable right now. Reopen the panel.",
};

for (const locale of ["en", "ar", "de", "es", "fr", "it", "ja", "pt", "ru", "zh-CN", "zh-TW"]) {
  test(`${locale} gives every enrollment failure its own message`, () => {
    const translation = JSON.parse(
      fs.readFileSync(path.join(__dirname, `../../src/locales/${locale}/translation.json`), "utf8")
    );
    const messages = translation.people.enrollmentErrors;
    assert.ok(translation.people.exemplarPlaybackKeyUnavailable);
    assert.notEqual(
      translation.people.exemplarPlaybackKeyUnavailable,
      messages.exemplar_key_unavailable
    );
    assert.match(translation.meetingAudio.permanentStorage, /\{\{used\}\}/);
    assert.match(translation.meetingAudio.permanentStorage, /\{\{clips\}\}/);
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(expected).sort());
    assert.equal(new Set(Object.values(messages)).size, Object.keys(expected).length);
    if (locale === "en") assert.deepEqual(messages, expected);
    for (const code of [
      "poor_audio",
      "echo_audio",
      "candidate_unavailable",
      "span_mismatch",
      "person_or_meeting_changed",
      "already_approved",
    ]) {
      assert.doesNotMatch(
        messages[code],
        /Try again|try saving again|Réessayez|Riprova|Erneut versuchen/i
      );
    }
  });
}
