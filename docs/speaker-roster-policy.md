# Desktop automatic speaker roster policy

This document describes the implemented participant boundary. Product choices
that still need the owner's decision are listed in
[the self-review](../artifacts/participant-scope-self-review.md).

## Scope and identity

`src/helpers/speakerRosterPolicy.js` resolves the note's declared participants.
A non-empty list restricts automatic names and suggestions to profiles with
exactly one matching normalized email. Display names, legacy profile links,
calendar attendees and participant order do not establish identity. Explicitly
declared entries remain eligible regardless of RSVP or resource metadata.

Both SQL NULL and a parsed empty array are unrestricted, including when a
calendar event is linked. A malformed list or missing note context fails closed.
Calendar edits do not change recognition scope. Declared participant edits
increment `speaker_roster_revision`, including changes through sync or direct
SQL; remove/re-add cannot make an old decision current again.

Acoustic matching ranks the global library first. Membership vetoes the winner;
it does not promote a participant runner-up. Existing similarity thresholds,
cohort ranking, duration/overlap checks, calibration and acoustic clustering
remain unchanged. Live and local final recognition require approved usable
voice evidence. Adding an attendee or attaching an email alone supplies no
speaker suggestion.

## The installation boundary

`automaticSpeakerAttribution.resolveAutomaticSpeaker` is shared by main and
renderer. `noteSpeakerScope.enforceRows` supplies current database scope at
installation and read projection. Its callers cover note creation/import,
ordinary and optimistic saves, cloud upsert/rebase/adoption/undo, People
rename/merge/delete/undo, live/reconsidered/merged assignments, final completion
(including skipped/failed paths), recording seeds and editor overlays.

Human choices, including explicit Unknown and portable human origin, retain
precedence. An action's restoration authority covers its affected row IDs only.
Undo restores row shape and attribution through the current boundary; an old
automatic name does not bypass a changed roster. New transcription IDs do not
inherit a veto through fuzzy text/time matching. Explicit parent lineage can
carry the controlling veto to a derived row.

A serialized decision, copied hash, new decision ID, changed audio coordinates
or copied proof object cannot supersede a recorded veto. Fresh retained-audio
evaluation issues a frozen object registered in a module-private WeakMap. The
handle binds the note, durable row, prior decision, recording/track/sample span,
content hash, roster generation, evaluated decision, winner and profile
fingerprints. Installation checks those facts and the current accepted-profile fingerprint against storage and
consumes the handle once. Fingerprints include profile identity, name, approval,
update timestamp and embedding bytes; timestamps alone are insufficient.

An equivalent reupload additionally requires the previous canonical hash and
intact parent recording/track/sample lineage. An explicit replacement can use
new retained audio when the original is gone, while recording its prior span
and parent recording. Decoding occurs asynchronously in a bounded child process.
Unsafe original spans remain vetoed; replacement duration uses the existing
short-span rule. Refusals retain their controlling veto and separate
`speakerBoundary` diagnostics.

Renderer IPC transports plain data, so it cannot carry the private handle.
Untrusted cached/late proposals remain vetoed. A main-enforced persisted
`note-updated` snapshot installs the authoritative committed attribution after
current-note projection. Structured-clone regressions cover that distinction.

## Legacy, sync, export and People

Undecided historical attribution survives context-free normalization and
unrestricted history/imports. Under a restricted or malformed roster, unknown
origin names (including mappings and old speaker strings) become reviewable
Unknown rows with `legacy_not_evaluated`, `speakerReviewRequired: true`,
`candidateSetStatus: "not_recorded"` and `acousticEvaluation: "not_evaluated"`.
Known human choices survive. Startup persists this migration once, including
inactive-account notes, and preserves unchanged transcript bytes.

Local serialization retains decisions, review state, boundary diagnostics and
portable origin. Public sync serialization uses an allowlist: local profile
IDs, candidate sets, acoustic vectors, local proof history and correction logs
do not travel. A rejected or invisible name supplies no contact email.
Accepted machine names carry portable email identity for local scope validation;
this import does not claim a local acoustic evaluation. Human origin remains
authoritative across import, including explicit Unknown.

Editor, export, attendee inference and People usage/review respect recorded
vetoes and human choices before consulting legacy mappings. People shows missing
candidate-set evidence honestly. Explicit attendance records remain attendance
records; recognition policy does not create or rewrite attendance, contacts,
profiles or enrollment samples.

## Schema and performance

Schema version 6 replaces the broad FTS update trigger with a trigger limited
to indexed note fields whose values changed. This prevents nested roster
revision updates from corrupting the external-content index. Upgrades below 6
rebuild the index once; subsequent opens do not reinsert every note. Regression
fixtures include a database created by the unmodified 1.13.4 implementation,
with both clean and deliberately corrupt index variants, plus fresh databases.

Each completion read/retry prepares one batch-owned roster snapshot and indexes
rows by ID. Full transcript parsing remains a constant pipeline cost: it is not
one parse for the entire handler. The editor and committed-row installer also
prepare their roster once per batch. Re-evaluation snapshots profiles once,
yields between rows, and releases handles through weak references when a batch
is discarded. Work and retained batch results still scale with row count;
model inference, audio I/O and database startup are not constant-time claims.

See the self-review for actual measurements, full-shard outcomes, expectation
changes and explicit confidence limits. Historical run reports are evidence of
those runs only; their superseded policy statements and baseline claims are not
current guarantees.
