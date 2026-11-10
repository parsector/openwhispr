# Desktop automatic speaker roster policy

`src/helpers/speakerRosterPolicy.js` is the shared, read-only policy module.
`eligible(scope, profileId)` is the membership veto. `mayAutoName(row, profile,
scope, evidence)` additionally requires an unprotected row, approved usable voice
evidence, an accepted acoustic decision, a current roster revision, and no
short/overlapping/ambiguous/mixed-span rejection. `noteSpeakerScope.js` loads the
scope, records decisions, and enforces it at commits and reads.

The acoustic library and ranking stay global. An outsider winner is rejected;
a participant runner-up is never promoted. An explicit `[]` is authoritative
and unrestricted, ignoring a linked event. `NULL` uses only its linked event,
or remains unrestricted when there is no link. Malformed data, missing note
context, or an unavailable linked event fail closed. This follows the explicit
empty-roster behavior in the requested precedence regression.

Email resolution trims whitespace, normalizes case, and requires exactly one
matching profile. Display names and legacy attendee/contact links are not
verified identities. Resources and declined non-self guests are excluded; self
is retained. Resolution never registers attendees or writes identities.

## Enforcement points

Line references refer to this implementation's source files.

| Path                                 | File:line                                                                                                 | Enforcement                                                                                                                                                                               |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope and predicate                  | `src/helpers/speakerRosterPolicy.js:11`, `:74`, `:82`                                                     | Declared/calendar/empty precedence; exact identity; membership and naming gates.                                                                                                          |
| Scope reads and provenance           | `src/helpers/noteSpeakerScope.js:14`, `:55`, `:99`                                                        | Read-only resolution; reconstructable snapshots; commit veto and revision checks.                                                                                                         |
| Retrieval                            | `src/helpers/database.js:7800`                                                                            | Optional explicit `noteId` scopes retrieval. Unscoped diagnostics retain their candidate set. Automatic acoustic comparisons use the unscoped API.                                        |
| Note/event revision changes          | `src/helpers/database.js:1214`                                                                            | Local generation and SQL triggers cover note edits, sync writes, calendar updates, replacement, deletion, and remove/re-add races.                                                        |
| Persist/read                         | `src/helpers/database.js:4477`, `:4687`                                                                   | Scope recorded rows on reads and writes, including stale renderer saves and sync changes. Repeated read vetoes are stable for optimistic saves. Historical unrecorded rows are unchanged. |
| Live IPC                             | `src/helpers/ipcHandlers.js:10081`, `:10092`, `:10131`                                                    | Pass scope and decision evidence through live identification and merge events; remove roster-only one-on-one suggestions.                                                                 |
| Live matching                        | `src/helpers/liveSpeakerIdentifier.js:1177`                                                               | Compute the global winner and existing floor/margin first, then veto membership or unapproved evidence.                                                                                   |
| Carry-forward                        | `src/helpers/liveSpeakerIdentifier.js:236`, `:1245`, `:1270`                                              | Revalidate transient names before reuse/export and retain their owning note and evidence.                                                                                                 |
| Reconsideration                      | `src/helpers/liveSpeakerIdentifier.js:277`; `src/helpers/liveSpeakerReconsideration.js:61`, `:97`, `:112` | Veto global winner, record rejection evidence, recheck current database scope, preserve every human lock.                                                                                 |
| Anchors                              | `src/helpers/liveSpeakerIdentifier.js:357`, `:383`                                                        | Membership and revision gate activation/revalidation; revoked anchors cannot name new clusters.                                                                                           |
| Automatic merges                     | `src/helpers/liveSpeakerIdentifier.js:532`                                                                | Propagate evidence; a manual outsider correction cannot supply an automatic name for another merged cluster. Cluster computation is unchanged.                                            |
| Retroactive/one-on-one               | `src/helpers/ipcHandlers.js:14938`, `:15019`                                                              | Rank globally and require approved acoustic evidence and current membership before suggesting. A participant list alone supplies no name.                                                 |
| Reconciliation                       | `src/helpers/ipcHandlers.js:15026`, `:15071`                                                              | Scope inherited names and suggestions; clear rejected cached names.                                                                                                                       |
| Final, skipped and failed completion | `src/helpers/ipcHandlers.js:15231`, `:15332`                                                              | Snapshot at run start; re-read locks and scope at final delivery, including fallback paths.                                                                                               |
| Final confirmed/raw suggestions      | `src/helpers/ipcHandlers.js:15707`, `:15833`                                                              | Veto raw winner before confirming/suggesting; preserve all acoustic, duration and ambiguity checks.                                                                                       |
| Cohort suggestions                   | `src/helpers/ipcHandlers.js:15762`                                                                        | Global cohort ranking stays unchanged; outsider suggestions are vetoed.                                                                                                                   |
| Export                               | `src/helpers/transcriptFormatter.js:5`, `:65`                                                             | Recorded rejection outranks mappings; differently resolved rows cannot merge into a named export row.                                                                                     |
| Renderer resolution/serialization    | `src/utils/transcriptSpeakerState.ts:72`, `:316`, `:364`, `:387`                                          | Clear vetoed labels/suggestions; retain evidence; stale mappings cannot restore a name.                                                                                                   |
| Renderer live caches                 | `src/stores/meetingRecordingStore.ts:705`, `:750`, `:799`, `:1505`, `:1520`, `:1626`, `:1651`             | Carry evidence with cached names, retire stale revisions, protect human rows, reject delayed live/reconsideration/merge replies.                                                          |
| Correction and late transcript merge | `src/helpers/speakerCorrectionTransaction.js:3`, `:36`; `src/helpers/transcriptDocument.js:422`           | Include evidence in undo/split snapshots; all lock representations win; a veto cannot be replaced by a cached machine assignment.                                                         |
| Attendee consumer                    | `src/helpers/connectors/contactSearch.js:118`                                                             | Recorded/locked row identity outranks stale mappings; Unknown never becomes inferred attendance.                                                                                          |
| People usage/review evidence         | `src/helpers/peopleActions.js:404`, `:1652`                                                               | Derive usage from accepted row identities; vetoes and human Unknown block stale mappings. Historical review evidence explicitly reports `candidateSetStatus: "not_recorded"`.             |
| Owner explanation                    | `src/components/notes/NoteParticipants.tsx:229`; `src/components/notes/NoteEditor.tsx:1509`               | Uses the same effective scope, including calendar fallback and malformed-data failure; strings in all eleven locales.                                                                     |

## Stored provenance

Each new machine decision is serialized as `row.speakerDecision` (typed in
`src/types/speakerRoster.ts`):

- `candidateSetStatus`, `decisionId`, `runId`, `noteId`;
- `source`, `revision`, `rosterRevision`, `linkedEventId`;
- `rawRoster`, parsed `roster`, `unrestricted`, `scopeFailure`, `eligibleProfileIds`;
- `policyVersion`, `acceptedProfileId`, `acousticWinnerProfileId`, `origin`, `path`;
- `scores`, `rejectionReason`, `profileFingerprints`, `modelFingerprint`;
- `previousDecision` when a later roster veto supersedes a decision.

The profile fingerprint hashes identity, approval/cache metadata and vector
bytes. The model fingerprint hashes the actual model file; unavailable data is
`null`, never an invented fingerprint. Roster changes produce new snapshots;
prior snapshots survive in `previousDecision`. Historical rows are not assigned
retrospective candidate sets.

## Red, then green evidence

A separate `git archive 59356c41d` checkout ran the updated existing suites with
original source files. Its first replay had **239 tests: 192 passed, 47 failed**.
The same 239-test group passed with the implementation. A later original-source
replay of five added regressions had **five failures**, including scoped
retrieval returning `[A, C]` instead of `[A]` and an unapproved participant still
appearing as a suggestion. A final original-source replay of six consumer, renderer and explanation
regressions had **six failures**. No missing-module failures are counted here.

| Required regression               | Observed original failure                                                                                                | Passing regression coverage                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner A/B, C=.95 > A=.70 > B=.30  | Final/live/reconciliation/cached/retroactive paths returned or suggested C.                                              | `meetingSpeakerReconcile`, `liveSpeakerIdentifier`, `liveSpeakerReconsideration`; Unknown, no runner-up promotion.                                                                                       |
| Cohort                            | Raw winner A was invited, but cohort winner C appeared as a suggestion.                                                  | `roster cohort suggestion cannot name outsider C when raw winner A is invited`.                                                                                                                          |
| Positive recognition              | A was correctly named originally, but its roster snapshot was absent.                                                    | A remains named and now records the actual roster; existing approved-voice reconsideration/anchor positives still pass.                                                                                  |
| Outsider cluster                  | The extra cluster was named C.                                                                                           | Distinct Unknown cluster survives beyond the participant count; participant A still names correctly.                                                                                                     |
| Precedence                        | Declared A/B, broader linked event, or malformed roster still allowed C.                                                 | Declared roster wins; malformed/missing event fails closed. Empty and absent-without-event controls already named C originally and continue to do so; their new provenance assertions originally failed. |
| Identity                          | Name-only, missing profile/email, duplicate names/emails, resources and declined guests still allowed the global winner. | Exact normalized email only; ambiguous/name-only cases Unknown; self and normalized email positives retain names.                                                                                        |
| Concurrency                       | A survived removal during final recognition; stale reconsideration and live withdrawal retained names.                   | Add/remove during final; delayed retroactive job; remove/re-add and resumed recording; sync edits; linked-event replacement; delayed live, reconsideration and merge replies.                            |
| Human protection                  | Late final overwrote manual outsider/Unknown under each lock representation; merges spread a manual outsider name.       | Eight late-final lock/name combinations; row-vs-cluster correction, undo under changed roster, anchor withdrawal, explicit Unknown consumers and merge scope.                                            |
| Consumers                         | Export/UI restored C; People usage was 1 instead of 0; attendee lookup returned C from a stale mapping.                  | Export/UI Unknown agree; accepted row uses its own profile; stale and locked-Unknown mappings supply no usage/attendance.                                                                                |
| No identity/training side effects | Scoped retrieval originally ignored `noteId` and returned outsiders.                                                     | Scoped and unscoped retrieval controls plus counts of attendance, contacts, profiles, exemplars/audio and enrollment candidates.                                                                         |
| Diagnostics unchanged             | Expected unchanged controls, not a failing bug regression.                                                               | The same 82 calibration/admission/export/enrollment/threshold tests and 16 in-app calibration/profile-check tests pass on original and changed source. Candidate sets/rankings/fingerprint/scope code is unchanged.                                    |

New-module tests additionally demonstrated failures before their fixes for
mutable snapshots (`3 !== 2`), unrelated library additions changing a revision,
missing note identity becoming unrestricted, linked-event remove/re-add reusing
a revision, and read-time veto IDs making optimistic saves unstable. Renderer
regressions demonstrated `'C' !== undefined` before stale asynchronous replies
were rejected. These are implementation-stage red/green results, separate from
the original-commit replay.

The original replay command was:

```sh
node --import tsx --test test/helpers/meetingSpeakerReconcile.test.js test/helpers/liveSpeakerIdentifier.test.js test/helpers/liveSpeakerReconsideration.test.js test/helpers/liveSpeakerAnchor.test.js test/helpers/transcriptFormatter.test.js test/utils/segmentSpeakerName.test.js test/helpers/connectors/contactSearch.test.js test/helpers/peopleActions.test.js test/stores/meetingRecordingStoreDiarizationPublish.test.js
```

## Verification and scope

The requested speaker suites plus both new-module suites pass (208 tests).
The repository's attendee suite is `test/services/noteAttendees.test.js`, not
`test/helpers/noteAttendees.test.js`; verification uses the existing path.
Closest consumer/database/calendar/correction/renderer/registry suites pass
(180 tests), with 64 further UI/registry checks after the explanation change. Calibration,
enrollment and threshold controls pass on both original and changed source
(82 tests each), as do the 16 in-app calibration/profile-check tests. Locale coverage, lint, typecheck, renderer build and routine-tool
compilation are checked; the regenerated `toolAssembly.cjs` is included and the
registry tests verify the shared assembly.

Deliberately excluded: mobile; version/changelog/tag/release/push changes;
acoustic thresholds; diarisation counts or centroid algorithms; calibration and
profile-check ranking/scope; enrollment and retention changes; retrospective
migration or relabeling of unrecorded historical notes. No name-only or legacy
identity link is treated as verified. Existing independent People registration
workflows are unchanged; the new resolver never invokes them. No real-audio or
packaged Electron smoke test was performed; matcher regressions use deterministic
vectors and real matching code, plus real SQLite and renderer seams.
