Fix run 6 — attribution installation, proof integrity and large-note retries

Baseline: `06a57ce572b46e558168889c8b7966be378af8b1`, on `master`.
The commit message is `fix(speakers): make the boundary the sole writer, unforgeable, and linear on large notes`.

The boundary is still `resolveAutomaticSpeaker` in `src/helpers/automaticSpeakerAttribution.js`. Main's `enforceRows` / `enforceTranscript` adapters obtain the current note roster, identities, legacy mappings and profile fingerprints, then delegate installation to it. No scope permits preserving a historical projection; it does not permit installing a changed automatic identity. A recording seed takes existing attribution from the authoritative persisted row, rather than its supplied copy.

Evidence is a frozen object registered in a module-private `WeakMap`, only after canonical retained audio was read, decoded, hashed, embedded and evaluated by the actual row matcher. There is no plain-data mint operation. The private record binds the durable row, previous decision, original span/hash, evaluated span/hash, recording lineage, roster revision, exact evaluated decision ID, winning profile/name and profile fingerprints. Installation compares these private facts against the stored row and current library. It consumes the handle once. JSON serialization, object spread and copied hashes cannot enter the `WeakMap`; a consumed handle cannot authorize another installation. A caller cannot pair a real handle with a different winning profile or decision. Installation copies the private evaluator result and diagnostics rather than caller-edited fields. Rejected proposals cannot alter the canonical span/hash, and omitted fields cannot remove the stored binding before a later swap.

Main passes live handles to the database through the in-process `speakerEvaluations` map. They are attached after transcript parsing and consumed at installation, rather than consumed once while constructing a proposal and again at persistence. Serialized evaluation metadata is diagnostic history, not authority. Renderer proposals containing copied proof metadata cannot supersede a veto. Authoritative `note-updated` snapshots come from main's enforced persistence and are projected against the current note before display.

A `reupload` transition requires an existing canonical hash equal to the newly computed hash, the previous decision ID, unchanged track/sample bounds and the exact parent recording identity. An explicit `replacement` transition can evaluate a new retained span even when the original audio is gone; it records its parent recording, prior span and whether the hashes matched. The live reconsideration IPC accepts explicit replacement requests; a request alone cannot issue evidence. `not_sure` and `close_match` are reassessed with the new row evaluation. A longer explicit replacement can recover `too_short` using the existing `shortSpanReason` rule. Overlap and mixed-audio safeguards remain in place. A new transcription ID does not acquire attribution or a veto through fuzzy text/time correspondence; explicit parent lineage still transfers a controlling veto.

Every refusal has separate `speakerBoundary` provenance: `row_binding`, `audio`, `profile`, `revision`, `missing_proof`, `reused_proof`, or `scope_missing` (and rejected-proposal provenance). The previous machine veto remains the controlling decision rather than being overwritten with the proposed acceptance or a new rejection. A failed initial proof or an attempted reuse of an old acceptance on swapped audio becomes an unevaluated rejection, not a recorded acoustic acceptance.

Under a restricted roster, an unknown-origin legacy name becomes **Unknown speaker N**, with `legacy_not_evaluated`, `speakerReviewRequired: true`, `candidateSetStatus: "not_recorded"` and `acousticEvaluation: "not_evaluated"`. This includes names in `speakerName`, old speaker strings and legacy mappings. The editor's Review filter and People review include it; both show the same attribution and “Not assessed.” People also retains “Candidate set not recorded.” Known human locks, explicit human Unknown and portable human-origin choices remain authoritative. Identity-only sync imports also say “Not assessed”; they do not invent a local acoustic evaluation. Migration persists the legacy outcome once and leaves unchanged transcript representations alone, preserving optimistic save and history migration tokens. Migration uses stored note scope even for inactive-account notes inaccessible to the account-filtered reader.

The new or changed installation sites are listed below. All paths eventually use the same boundary, including proposals constructed by helper functions.

| Site | Installation or projection |
| --- | --- |
| `database.js`, startup speaker history migration | Scopes the migrated transcript before writing; also migrates restricted legacy names and skips unchanged results. |
| `database.js:saveNote` | Inserts an empty attribution first; installs supplied transcript through the boundary after the real local note ID exists. |
| `database.js:importNotes` | Same rule for bulk imports, using the inserted note's declared roster. |
| `database.js:_withSpeakerDisplayNames` | Projects every structured transcript, including unrecorded legacy rows; no conditional evidence-only exemption. |
| `database.js:updateNote` | Scopes every structured write, retains authoritative stored rows, injects issued evaluations, and supplies current scope to optimistic reconciliation. |
| `database.js:upsertNoteFromCloud` | Scopes existing-note attribution before upsert against the roster the SQL will install. New notes are inserted without attribution, then receive a scoped transcript after their local identity exists. |
| `database.js:takeCloudSpeakerLabels`, adoption | Explicit human adoption is installed through the boundary. |
| `database.js:takeCloudSpeakerLabels`, undo | Restoration releases locks only for the affected rows and revalidates automatic outsider attribution. |
| `database.js:setNoteCloudBase` | Scopes the rebased transcript before writing. |
| `peopleActions.js:applyPersonAction` | Rename/merge transcript writes pass through `enforceTranscript`. |
| `peopleActions.js:undoPersonAction` | Restored labels pass through the same boundary and affected-row restoration rule. |
| `peopleActions.js`, person deletion/history cleanup | Also routes transcript cleanup through the boundary. |
| `peopleActions.js:listPeople` and `assembleReviewRows` | Usage and review both project rows through editor policy; a stale mapping cannot name or associate a vetoed row. |
| `ipcHandlers.js`, live identification callback | Supplies current scope to provisional/confirmed/suggested installation. |
| `ipcHandlers.js`, reclustering timer / `_applySpeakerClusterMerges` | Reads persisted row decisions before proposing a cluster merge; stale ingestion copies cannot replace a renderer's veto. |
| `ipcHandlers.js:_retroactiveMapping` | Evaluates the actual row before issuing a handle; stages proposals and supplies live evidence to database installation. |
| `ipcHandlers.js`, final acoustic recognition | Supplies decision and proposed attribution together; cohort and uncertainty branches also validate before installing. |
| `ipcHandlers.js:_startOrSkipDiarization`, final send | Uses both original input rows and current saved rows as authoritative predecessors, including unsaved input vetoes. |
| `liveSpeakerReconsideration.js:reconsiderLiveClusters` | Uses the evaluated match, stages row proposals, and lets the database consume proof exactly once; publishes only committed acceptances. |
| `speakerAssignmentPolicy.js:applySpeakerUpdate` | Carries scope through the shared provisional/confirmed/suggested writer. |
| `meetingRecordingStore.ts:startRecording` | Fetches the current note and uses persisted attribution when seeding; supplied recorded claims without a canonical predecessor are refused. |
| `meetingRecordingStore.ts`, note-updated listener | Projects authoritative saved rows, clears obsolete uncertainty, and retires stale identity caches through current scope. |
| `meetingRecordingStore.ts`, completion initial/retry/resumed-live branches | Each supplies current note scope through merging and the final boundary, including a newer roster event arriving while an older commit reply is pending. |
| `NoteEditor.tsx`, display/overlay | Stamps completion and correction overlays with note/roster generation and authoritative transcript. A persisted recovery after enrollment also invalidates the overlay with the same roster. A roster edit discards the old overlay so it cannot hide either a veto or a later legitimate recovery. Current rows still pass through the boundary. |
| `transcriptDocument.js:reconcileAutomaticTranscript` | Carries the current scope from database reconciliation to all row proposals. |
| `transcriptSpeakerState.ts`, merge helpers / `diarizationCompletion.ts` | Carry scope from completion, use durable IDs/explicit parents for attribution lineage, and avoid transferring a veto to a replacement transcription. |

The retry parses `baseTranscript` once and builds an ID index. The initial completion lookup is indexed too. Profile fingerprints are computed once per preparation/matching/installation stage, with a fresh installation snapshot deliberately checked after async evaluation. `matchEligibleCluster` accepts a batch snapshot without changing its score calculation, thresholds or ranking. Canonical store reads use `spanAsync`; WAV conversion runs in a child process with a 10-second timeout and a 16 MiB output bound. The evaluation loop yields between rows, even with an immediately resolving extractor.

Red evidence was captured before implementation for the initial proof, legacy, retry, seed and transcription regressions. Expanded regressions were replayed against a detached checkout of the unchanged baseline. `speaker-boundary-run6-evidence.txt` contains the recorded failing names, representative assertions and measurements. No baseline implementation files were patched.

| Requirement | Baseline failure | Fixed result |
| --- | --- | --- |
| A: fabricated proof, through direct and main adapters | `speakerName` was `A`, expected `undefined`; copied hash also admitted changed recording/track/trim. | Refused; the original veto ID remains controlling. |
| A: reused proof / another row / older roster | Replay or a copied/rebound claim was accepted; issuance and consumption were absent. | Single consumption and private row/revision binding refuse each case. |
| A: changed profile / forged winner / initial proof / accepted proof on swapped audio | Profile/winner could be claimed; initial and stored accepted objects bypassed proof checking. | Refused with separate profile, revision, binding or missing-proof provenance. |
| A/C: identical reupload vs broken lineage | A copied hash alone was admitted; explicit replacement was unsupported. | Identical bytes plus intact lineage pass; broken lineage, missing hash or unverifiable audio fail. |
| B1: main merge/recluster | Actual timer body restored `A` over a persisted row veto. | Keeps the canonical veto while updating the structural cluster ID. |
| B2: final recognition | Overwrote an input veto before validation. | Keeps its exact prior decision ID. |
| B3: resumed completion | The separate live install displayed `Outsider`. | Fetches current scope and installs Unknown. |
| B4: editor overlay | Displayed stale `A` after a roster edit. | Discards obsolete overlay, displays Unknown, then permits the current persisted recovery. |
| B5: cloud undo, People rename/merge/undo | Raw transcript contained an automatic outsider name. | Raw stored row is Unknown; known human choices survive. |
| B6/D: legacy names and People projection | Restricted legacy names remained named; People read raw names while editor vetoed them. | Recorded unevaluated reason, review flag and matching editor/People attribution, including mapping-only rows. |
| B7: migration and import | Raw stored transcript still had `Outsider`. | Unknown is persisted before exposure; second startup is stable. |
| B8: recording seed | Supplied outsider / fabricated acceptance replaced the canonical state. | Current scope and canonical persisted veto control the seed. |
| C: transcription replacement | New row acquired the old veto/old ID through fuzzy correspondence. | Replacement keeps its new identity and does not inherit that veto. |
| C: enrollment/roster recovery | Fresh retained audio still skipped stale `not_sure`. | Actual new row evaluation restores the legitimate name after either change. |
| C: original audio gone / too-short replacement | No replacement evaluation was scheduled. | Explicit longer replacement evaluates and commits with durable parent provenance. |
| E: retry | 2,000 rows caused 6,010 full JSON parses and tens of seconds on the event loop. | 10 full parses and indexed row lookups. |
| E: responsive re-evaluation / profile snapshot | Heartbeat count was zero; matcher ignored supplied snapshot. | Heartbeats continue; preparation reads profiles once and the 2,000-match test performs zero profile reloads. |

There are 55 targeted bug regressions with baseline failure evidence; some evidence runs overlap. The additional positive optimistic-reconciliation scope test is not counted as a baseline failure. The dedicated migration suite is test/helpers/speakerLegacyMigration.test.js.

| Isolated synthetic measurement | Baseline 06a57ce57 | Fixed |
| --- | ---: | ---: |
| 2,000-row retry handler, forced save conflict | 35,501.5 ms | 203.8 ms |
| Full JSON parses during that handler | 6,010 | 10 |
| 2,000-row evaluation heartbeat | 0 ticks | 504 ticks in 565.9 ms |
| Profile reads during evaluation preparation | 1 | 1 |

The retry improvement is approximately 174× in this run. The deterministic complexity evidence is the parse count: a full-note parse for every output row becomes one parse and an ID index. The test verifies 2,000 distinct output rows. Timing measures the real store handler with a mocked IPC save conflict; it excludes Vite startup, model inference and disk latency. The heartbeat test exercises production preparation, hashing, embedding/matcher calls and issuance with decoding stubbed at the child-process boundary. It measures responsiveness, not model throughput. A separate 2,000-match test verifies zero profile reloads and reuse of the supplied fingerprint array.

Verification:

- The exact requested ten-helper command plus the dedicated migration suite: **271 passed** (269 helper tests and 2 migration tests).
- All meetingRecordingStore suites plus the full NoteEditor suite: **153 passed** (109 store tests and 44 NoteEditor tests).
- Transcript chat, speaker picker and surface-guard component suites: **44 passed**.
- People enrollment component suites: **17 passed**. People review browser component: **1 passed**, Chromium available and the test executed.
- Locale translation coverage: **9 passed**.
- npm run lint, npm run typecheck, npm run build:renderer: **passed**. The existing renderer large-chunk warning remains.
- git diff --check: **passed**.

Additional suite and measurement commands:

~~~sh
node --import tsx --test test/helpers/speakerLegacyMigration.test.js
node --import tsx --test test/stores/meetingRecordingStore*.test.js test/components/noteEditorSummaryDeletion.test.js
node --import tsx --test test/components/meetingTranscriptChat.test.js test/components/meetingTranscriptSpeakerPicker.test.js test/components/speakerSurfaceGuard.test.js
node --test test/components/peopleEnrollmentDecision.test.js test/components/peopleEnrollmentMessages.test.js
node --test test/browser/peopleReviewKeyboard.cjs
node --import tsx --test --test-name-pattern='run6: a 2000-row' test/stores/meetingRecordingStoreDiarizationPublish.test.js
node --import tsx --test --test-name-pattern='2000-row reevaluation' test/helpers/automaticSpeakerAttribution.test.js
~~~

The evidence file records baseline failure names, representative assertions, passing counts and measurement output. The unchanged detached baseline is /opt/data/cache/run6-baseline; only regression tests were copied there.

No threshold, diarisation algorithm, cohort-ranking rule, calibration, enrollment policy, retention, mobile, version or changelog changes were made. The 21 `SQLITE_CORRUPT_VTAB` failures in `noteCloudUpsertGuard.test.js` are pre-existing: baseline and fixed runs have the same 21 failing cases. They are left unchanged.
