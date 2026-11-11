# Participant-scope self-review

Review base: `59356c41d19caf7ad327ad0b7b7255c59a232784`, including all committed
changes through `137b881c8` and this run's worktree. The initial worktree was
clean and the branch was `master`. I read the source diff and all added/changed
tests. Separate Standards and Spec reviews supplemented that reading.

This is a review of the complete change set, not a release approval. Owner
questions at the end are unresolved product decisions.

## Findings fixed in this run

| Finding                                                                                                                                                                                                              | Regression and observed failure before the fix                                                                                                                                                  | Fix                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer saves lost review state, refusal diagnostics and portable assignment origin.                                                                                                                                | Three serialization round trips returned `undefined` for those fields. `serialization-red.tap`: 8 pass, 3 fail; green: 11 pass.                                                                 | Preserve the three fields in local serialization and type them on transcript rows. Public sync still uses its separate allowlist.                                                                                     |
| Portable human origin did not count as a lock in UI/export consumers. A stale mapping replaced a chosen name or explicit Unknown.                                                                                    | Four chosen-name/Unknown UI/export regressions failed. `human-origin-red.tap`; complete consumer green: 46 pass.                                                                                | Both lock consumers use the shared human-protection predicate.                                                                                                                                                        |
| A human-label protection changed acoustic merge decisions and anchor invalidation. The branch's changed expectation hid it.                                                                                          | Restoring the original merge expectation and requiring a human outsider's acoustic merge produced two failures. `merge-red.tap`: 70 pass, 2 fail; green: 72 pass.                               | Restore acoustic merging, invalidate the anchor as before, and clear inherited human naming caches on the enlarged cluster. Human rows retain their locks.                                                            |
| Committed-row installation repeatedly scanned the live array and parsed its roster for each row.                                                                                                                     | 2,000 rows caused 2,011,000 identity reads and thousands of parses. `committed-index-red.tap`: failed the operation-count assertion.                                                            | Index live rows and prepare one roster snapshot per batch. Green: 12,000 identity reads, 3 roster parses, 62.7 ms in the recorded run.                                                                                |
| Editor projection parsed the roster per row even though completion had been optimized.                                                                                                                               | The real editor body measured 6,007 roster parses on 2,000 rows. `editor-perf-red.tap`: failed.                                                                                                 | Prepare scope once inside the memoized projection. Green: 10 roster parses across the render lifecycle.                                                                                                               |
| Proof fingerprints omitted email and display name, relying on timestamp precision to detect identity edits.                                                                                                          | Two same-timestamp edits still installed `A`; `profile-red.tap`: 0 pass, 2 fail.                                                                                                                | Include normalized email and display name in the profile fingerprint. Both now refuse with `profile` while retaining the prior veto.                                                                                  |
| Roster vetoes erased internal identities used by existing acoustic merge guards and profile-to-cluster reuse.                                                                                                        | Three differential grouping regressions failed: revision-only change, participant withdrawal and initial outsider reuse. `acoustic-scope-red.tap`: 32 pass, 3 fail; four-suite green: 134 pass. | Keep a private acoustic identity per live cluster, separate from display-accepted names/IDs; preserve the original global acoustic matching, merge guards and keep choice. Never export or use that map to name rows. |
| Naming-anchor retirement also changed acoustic routing.                                                                                                                                                              | Two exact routing/centroid/count comparisons failed in `anchor-scope-red.tap` (35 pass, 2 fail).                                                                                                | Retain private acoustic routing anchors; retire only public naming availability on roster edits. Correction/undo/reset/deletion/approval or embedding revocation/merge/stop invalidate both.                          |
| Approved invited anchors emitted a name without decision evidence, so the main IPC callback stripped the legitimate name.                                                                                            | Both active and final callback producers failed the accepted-evidence assertion in `anchor-callback-red.tap` (37 pass, 2 fail).                                                                 | Successful current invited anchors emit a real `live_anchor` decision with measured scores; retired routing emits a rejection and no name. Combined four-suite green: 147 pass, no skips.                             |
| Removed-cluster caches retained decisions, human markers and mutation history.                                                                                                                                       | Four lifecycle regressions failed (`lifecycle-red.tap`: 48 pass, 4 fail), including repeated clear/delete/reset and merged-away history.                                                        | Clear retired entries while retaining sibling evidence. Twenty-cycle bounds pass; four-suite green: 151 pass, no skips.                                                                                               |
| Restricted legacy Review still displayed cached uncertainty candidate names after converting the row to Unknown.                                                                                                     | Two main/renderer regressions disclosed `Private outsider` in `legacy-candidates-red.tap`; both pass after the fix, with unrestricted legacy candidates unchanged.                              | Clear unassessed legacy candidate names under restriction, retaining the uncertainty reason and review marker.                                                                                                        |
| Verification/documentation overstated guarantees. A provisional-suggestion case had been deleted, the schema upgrade used a downgraded current database, and test names claimed calendar paths they did not execute. | The restored real-evidence provisional-suggestion case passes its original eligibility assertion. Added 1.13.4 fixture upgrade tests pass for clean and corrupt indexes.                        | Restore the case with actual current evidence; add the old-schema fixture; rename misleading tests; rewrite policy and changelog statements.                                                                          |
| A full-shard reconnect assertion ran before lazy auth reconciliation had committed; ten timer turns were not a readiness signal.                                                                                     | Shard 3 failed the session-atom-first reconnect case; an isolated current run failed same-account reconnect. `auth-current.tap`: 11 pass, 1 fail; `auth-event-green.tap`: 12 pass, no skips.    | Wait for the validated-generation commit event inside React.act. Every state and intermediate-history assertion remains; cold imports remain exercised. No production auth code changed.                              |

Evidence logs live in `/opt/data/cache/participant-review/`. Red runs preceded
the corresponding functional fixes. No test was deleted or deliberately skipped,
and no acoustic threshold, cohort ranking or calibration setting was changed.
The generated routine assembly was rebuilt from the reviewed source.

The full shard also caught an inconsistent viewer fixture: the branch had added
portable human origin to a row with no chosen name, which means explicit human
Unknown under the unified rule. That marker was reverted, retaining the original
viewer-mapping expectation. The existing regression failed in the first full
shard and passed after the fixture correction; human Unknown regressions remain
unchanged and passing.

## Review by area

### Boundary and proofs

**Guarantees:** A recorded machine veto controls the row until a current,
row-bound evaluation of retained canonical audio is installed. Handles are
private WeakMap objects, single-use, bound to note/row/prior decision, media
lineage/content, exact evaluator decision/winner and current accepted-profile/roster
fingerprints. JSON, spread copies, matching hashes, changed coordinates and new
decision IDs do not mint authority. Refusal diagnostics survive renderer saves.
The previous controlling veto is retained separately from the refused proposal.

**Deliberately does not guarantee:** Every first-pass machine decision is a
portable proof. Initial live/final recognition, human actions and scoped portable
imports have distinct provenance. Installation rechecks the accepted profile; it does not rerun ranking for every
change to another competing profile. The original candidate snapshot is recorded.
The renderer cannot consume main's private handle. Authoritative persisted `note-updated` installs main-enforced results;
arbitrary copied reconsideration responses remain refused. Structured-clone
regressions exercise this transport distinction.

**Confidence limit:** Deterministic vectors and retained test audio establish
binding and gating, not real-world speaker accuracy or resistance to a compromised
main process. No packaged Electron or microphone smoke was run in this review.

### Legacy and scope rules

**Guarantees:** A non-empty declared note list resolves exact, unambiguous,
normalized email identity. The global acoustic winner is vetoed after ranking;
there is no participant runner-up promotion. Malformed/missing context fails
closed. Unknown-origin legacy names under restriction become persisted,
unevaluated, reviewable Unknowns. Human choices remain authoritative. Unchanged
unrestricted history keeps its names and bytes where no migration is needed.

**Deliberately does not guarantee:** SQL NULL does not inherit calendar attendees.
NULL and parsed `[]` are unrestricted. Explicit declined/resource entries are
not filtered. Name-only attendee links are not identities. A roster alone cannot
supply a suggested speaker.

**Confidence limit:** These NULL/calendar and explicit-entry semantics are
product choices requiring the owner's answer below; the code and rewritten
policy now agree about what is actually implemented.

### Sync and export

**Guarantees:** Rejected or invisible automatic names do not export contact
emails. Public serialization excludes local candidate sets, profile IDs,
embeddings, correction logs and proof history. Portable human origin protects
both names and Unknown on another device. Imported accepted machine email
identity is resolved locally and vetoed against current participants. Text-only
cloud reconciliation preserves local attribution before contextual installation.
Raw storage and returned cloud notes are checked, not just UI projections.

**Deliberately does not guarantee:** A receiving device performed the originating
acoustic evaluation. Identity-only import says `not_evaluated`/`not_recorded`.
Sync does not transport an unforgeable local handle. Existing note attribution
remains locally owned; cloud-label adoption is an explicit human action.

**Confidence limit:** No live two-account cloud service session was exercised;
coverage uses real SQLite with cloud payload fixtures and renderer IPC fixtures.

### Undo and correction

**Guarantees:** Correction results return the actually committed row shape and
an explicit affected-row set. Restoring a human lock requires action authority
for those rows. Unaffected rows and their cached windows survive. Undo restores
saved attribution through the current participant boundary, so roster edits
between correction and undo can legitimately yield Unknown. A newer note scope
arriving during IPC wins. Exact IDs/explicit parents carry lineage; fuzzy
text/time replacement does not transfer a veto to a new transcription identity.

**Deliberately does not guarantee:** Undo can resurrect an automatic outsider or
recreate missing acoustic evidence. A cluster label is not authority to name
unrelated audio. Undo is still subject to existing action ordering/history limits.

**Confidence limit:** Deterministic tests cover row/cluster corrections, split,
cloud adoption, People undo, late rows and roster races; they are not a manual
multi-window Electron acceptance run.

### People

**Guarantees:** Usage/review and editor projection agree on recorded attribution.
Vetoed rows and explicit human Unknown do not acquire usage or inferred attendance
from stale mappings. Portable human choices receive the same precedence as other
locks. Legacy review requirements survive save/reload. Candidate-set absence is
shown honestly. Scope resolution creates no contacts, profiles, attendance or
training evidence.

**Deliberately does not guarantee:** Existing explicit attendance records are
rewritten by recognition policy. A name-only human choice necessarily resolves
a unique local profile. Review eligibility still follows existing enrollment,
retention and sample-limit rules.

**Confidence limit:** The separate browser check and its real outcome are
reported with validation below; helper tests alone are not browser verification.

### Migration and schema

**Guarantees:** Version 5 upgrades to 6 without bypassing earlier migrations.
FTS updates only when indexed fields change. Nested participant revision updates
cannot double-delete/reinsert indexed text. Upgrades rebuild once; later opens
do not duplicate index rows. Fresh databases, an actual old application-created
schema, and a corrupt old index all retain searchable title/body/summary content.
Local edits, cloud updates, replay, clearing fields and deletion preserve index
integrity. Legacy migration preserves human choices and is stable on second open,
including inactive-account notes.

**Deliberately does not guarantee:** Recovery from arbitrary SQLite file
corruption or automatic rebuilding of an already-version-6 index damaged by
unrelated code. The upgrade fixture contains synthetic application-created
records, not a private customer database.

**Evidence:** `test/fixtures/speaker-scope/1.13.4.db.gz` was created by unmodified
`DatabaseManager` at `538c0d02d`, has version 5 and no roster revision column.
Its README records its hash and generation inputs. All four FTS tests passed;
cloud + FTS validation passed 50/50 without skips.

### Performance

**Guarantees:** Completion initial/retry/skipped/failed/resumed-live paths prepare
a batch-owned scope per note snapshot and index row lookups. The actual 2,000-row handler
regressions assert exact full-document parse counts, distinct output identities,
and a bounded total parse count. Editor projection and committed-row installation
also have 2,000-row operation-count regressions. Re-evaluation uses an async audio
read in production, a child-process decoder with a 10-second/16-MiB bound, one
profile snapshot per preparation batch and a yield between rows. Matching reuses
that snapshot; installation checks one fresh library snapshot per commit batch.

**Deliberately does not guarantee:** One parse for the entire completion handler,
constant-time inference, instant 2,000-row audio processing, or fixed wall-clock
latency under concurrent compiler/test load. The pipeline currently performs four
full-document parses per read snapshot, eight when a retry reads a second snapshot.
Batch result memory remains proportional to rows, embedding sizes and profiles.

**Confidence limit:** Timing and heap measurements below are local synthetic
measurements. The decoder boundary is stubbed for 2,000-row heartbeat/heap runs;
they establish event-loop yielding and bounded retained batches, not production
model/audio throughput. Existing live windows retain only 30 seconds of incoming
identifications. Acoustic identity/anchor maps retain at most one entry per live
cluster and clear on the corresponding merge/reset/stop or explicit invalidation.
Weak handles do not create a permanent registry.

### Tests and verification discipline

**Guarantees:** Reviewed assertion changes are inventoried below. Functional fixes
were reproduced red at their actual consumer seam before implementation. Full
shards cover neighboring surfaces beyond the touched files. No failure is called
pre-existing without the exact test being run on `538c0d02d`.

**Deliberately does not guarantee:** Targeted green is a full-suite green. Aborted
resource-limited runs, browser timeouts and incomplete shards are reported as such.
Existing optional/environment skips, if any, remain visible in shard totals.

**Confidence limit:** Linux ARM64 Node 26.7.0 is the available runtime; workflows
install Node 24. Native database tests execute here. Platform-native desktop,
mobile, notarization and live cloud-service checks are not part of the JavaScript
workflow command.

## Every changed existing expectation / fixture

The table inventories semantic changes, not whitespace-only formatting or added
assertions that retain all old assertions.

| File / affected case                                              | Behavior changed? Why the final expectation is right                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calendarDatabase`: pre-v2 reopen and shared-RSVP repair          | Schema only: final `user_version` is 6 rather than 5. Earlier calendar repair assertions remain.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `connectorActionsDatabase`: version-3 calendar re-sync            | Schema only: subsequent migrations now finish at 6. Token-clearing assertions remain.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `voiceEnrollment`: query indexes after version-3 reopen           | Schema only: final version 6, same index/query results.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `voiceEnrollment`: review eligibility fixture                     | Fixture starts unlabelled instead of deleting a persisted human lock via an ordinary save. Human protection is an intentional behavior change; enrollment eligibility assertions were not weakened.                                                                                                                                                                                                                                                                                                           |
| `meetingSpeakerReconcile`: one-on-one roster suggestion           | Yes: roster alone no longer suggests Alice; status stays provisional, no mapping/training side effect. Names require acoustic evidence.                                                                                                                                                                                                                                                                                                                                                                       |
| `meetingSpeakerReconcile`: attaching an email                     | Yes: no unranked Alex suggestion/status. Email establishes possible identity, not voice evidence.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `meetingDiarizationEpochTimestamps`: injected Sam final           | Yes: an automatic name without an owning note/evidence is refused. The same ingestion ID, row count, timestamp and `finalRevision` remain asserted, with explicit failure provenance added.                                                                                                                                                                                                                                                                                                                   |
| `liveSpeakerIdentifier`: approved voice and cap fixtures          | Fixture supplies scope and approval explicitly. Positive recognition and cluster-ID/count assertions remain. Missing context is intentionally fail-closed.                                                                                                                                                                                                                                                                                                                                                    |
| `liveSpeakerIdentifier`: unidentified/identified merge            | Fixture now distinguishes automatic evidence from human choice. This run also requires a human cluster's acoustic merge to occur without propagating its label; original clustering behavior is retained.                                                                                                                                                                                                                                                                                                     |
| `liveSpeakerAnchor`: merge and anchor invalidation                | The branch changed merge=1/anchor=null to merge=0/active. That was a prohibited behavior change, not a justified new expectation. Reverted in this run; original merge/invalidation assertions pass.                                                                                                                                                                                                                                                                                                          |
| `liveSpeakerAnchor` / `liveSpeakerReconsideration`: Alex fixtures | Add email, declared scope and retained-audio support to exercise genuine positive recognition. Lock, uncertainty, cohort and approval assertions remain.                                                                                                                                                                                                                                                                                                                                                      |
| `liveSpeakerReconsideration`: provisional-suggestion eligibility  | The branch deleted this case. Restored with a current accepted acoustic decision: bare legacy suggestedName under restriction is now intentionally unassessed, while a genuine suggestion retains its original eligibility refusal.                                                                                                                                                                                                                                                                           |
| `noteCloudUpsertGuard`: fresh-device human import                 | Yes: portable human choices now import `speakerLocked:true` and lock source `user`, while local profile IDs/history remain absent.                                                                                                                                                                                                                                                                                                                                                                            |
| `noteCloudUpsertGuard`: six legacy undo/text fixtures             | Their common cloud shell declared a non-empty roster. Those tests concern legacy-label restoration, so they now explicitly declare `[]`. Their original label/text/history assertions remain. A separate restrictive-cloud control asserts Unknown, review marker and revision increment; restriction is not bypassed. Cases: adoption→correction undo, older correction/later adoption, separate histories migration, legacy adoption order, whole-transcript legacy adoption, label-only text preservation. |
| `meetingRecordingStoreResumeSpeakerIds`: live evidence fixture    | Supplies owning note and accepted machine evidence; recognition cannot rely on a missing note. Existing ID reservation checks remain.                                                                                                                                                                                                                                                                                                                                                                         |
| Same file: undo cached identification                             | Fixture installs each affected row's restored veto before removing its mapping. Mapping absence alone is not an acoustic veto for the entire cluster. Delayed replay must not recover Sam.                                                                                                                                                                                                                                                                                                                    |
| Same file: correction/adoption cache expectations                 | Yes: an unrelated row/window stays assessed and named Alex. Previously all identification windows were cleared. Row-scoped corrections must preserve siblings.                                                                                                                                                                                                                                                                                                                                                |
| `NoteEditorSummaryDeletion`: correction IPC stub                  | Adds affected row IDs to match the actual response contract; existing assertions remain.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Same file: recorder/viewer self-name fixtures                     | Marks stored recorder choices explicitly. The branch's human-origin marker on an unnamed viewer row was incorrect and is reverted: it falsely declared an explicit human Unknown. The original viewer-mapping expectation remains; no human-Unknown assertion was weakened.                                                                                                                                                                                                                                   |
| Same file: deterministic legacy-tab regression                    | Same product expectation; test explicitly runs the deferred note-change frame after the tab click, exposing the render/reset race instead of relying on scheduling luck.                                                                                                                                                                                                                                                                                                                                      |
| `meetingRecordingStoreDiarizationPublish`: common note fixture    | Explicit unrestricted roster/revision replaces missing scope ambiguity; existing assertions remain.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `peopleReviewKeyboard`: retained row fixture                      | Marks missing candidate evidence, then adds visible-label assertions. Focus/keyboard assertions remain.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `useAuthOfflineAccount`: successful response readiness            | No product behavior or assertion changes. Await the actual generation-validation event instead of assuming ten timer turns complete lazy dependencies; retain signed-in, offline, purge, profile and render-history checks, with a bounded fixture-failure deadline.                                                                                                                                                                                                                                          |
| Two new calendar-named tests                                      | Renamed to supplied scope rendering / direct SQL roster edit: their old titles overstated the exercised path. Assertions were not weakened.                                                                                                                                                                                                                                                                                                                                                                   |

## Claimed baseline rechecked

Copied the exact current `noteCloudUpsertGuard.test.js` into a detached
`538c0d02d` checkout; no baseline implementation files were patched. Result:
**46 tests, 44 passed, 2 failed, 0 skipped**. The two failures are the intentional
new human-origin import protection and restrictive-cloud legacy-name regression.
The prior report's 21 `SQLITE_CORRUPT_VTAB` failures were reproduced against an
intermediate branch state, not 1.13.4. Its claim that they were release-baseline
failures is withdrawn. Current cloud suite plus FTS checks passed 50/50.

The final shard also exposed timing-sensitive successful-reconnect assertions in
`useAuthOfflineAccount.test.js`. The exact pre-fix test file at `538c0d02d` passed
**12/12 twice**; auth source and the fixture were unchanged from that commit.
Those passes do **not** justify calling the observed current failure pre-existing.
The test assumed ten timer turns completed lazy Vite imports and account-scope
reconciliation. The corrected fixture waits for the actual validated-generation
commit event inside React.act, retains cold imports and every intermediate-state
assertion, and fails within five seconds if reconciliation never completes.
The original gate failure and isolated red are retained; the corrected file
passed 12/12. Standards and Spec reviewers separately confirmed no assertion
weakening. The whole affected shard is rerun; other shards' source and test
partitions are unchanged.

## Validation and measurements

Actual 2,000-row completion measurements from `completion-paths.tap`:

| Completion path  | Full-document parses | All JSON parses | Handler time (ms) |
| ---------------- | -------------------: | --------------: | ----------------: |
| Initial          |                    4 |               7 |             484.1 |
| Conflict / retry |                    8 |              14 |             432.1 |
| Skipped          |                    4 |               7 |             348.0 |
| Failed           |                    4 |               7 |             308.4 |
| Resumed live     |                    4 |               7 |             413.5 |

These runs include the actual store handler, with IPC/model work mocked; they do
not include Vite startup in the handler timing. All five assert 2,000 distinct
saved row identities and pass. The original retry test retains its existing
parse/time limits. The new resumed test initially had an incorrect seeded-session
fixture and cleanup after browser teardown; those test harness errors were fixed,
not accommodated by weaker production assertions.

The actual preparation/matching loop measured **4,081.3 ms, 1,850 heartbeat ticks,
one profile preparation read** for 2,000 rows under concurrent load. A separate
2,000-match run performed zero profile reloads. Decoder completion was stubbed at
the child-process seam; no synchronous per-row decoder was substituted into the
production path. The reproducible supplemental `participant-scope-memory-check.cjs` ran five
2,000-row preparation/discard/GC cycles: discarded heap 9.19, 9.15, 9.17,
9.17 and 9.19 MiB; retained heap 13.67–13.76 MiB and external memory 3.60 MiB.
Each batch read profiles once.
This shows no accumulating batch registry in that run; it is not a general proof
of all application memory behavior.

`lint`, `typecheck`, `build:renderer`, routine assembly generation and
`i18n:check` passed. The renderer build reports large chunks. The separate People
keyboard/browser check executed in Chromium and passed 1/1 without skips on its
warm run; its initial cold Vite dependency build exceeded page navigation's
existing 15-second timeout. No timeout or assertion was weakened.

The full release-workflow glob ran in all four partitions. Actual final results:

| Shard               |      Tests |     Passed | Failed | Cancelled | Skipped |  TODO | Minutes |  Exit |
| ------------------- | ---------: | ---------: | -----: | --------: | ------: | ----: | ------: | ----: |
| 1/4                 |      2,830 |      2,821 |      0 |         0 |       8 |     1 |    38.4 |     0 |
| 2/4                 |      2,842 |      2,838 |      0 |         0 |       4 |     0 |    52.4 |     0 |
| 3/4, complete rerun |      3,010 |      3,002 |      0 |         0 |       8 |     0 |    15.1 |     0 |
| 4/4                 |      3,165 |      3,150 |      0 |         0 |      15 |     0 |    51.4 |     0 |
| **Total**           | **11,847** | **11,811** |  **0** |     **0** |  **35** | **1** |       — | **0** |

There were eight suites. The first command was:

```sh
GOMAXPROCS=2 node --import tsx --test --test-concurrency=1 --test-shard=1/4 --test-reporter=tap 'test/**/*.test.js'
```

Shards 2/4 and 4/4 used the same command with their shard number. The final 3/4
rerun used `--test-concurrency=2`; its initial attempt used 1. The initial 3/4
attempt finished with 3,010 tests, 3,000 passes, two failed counts (the reconnect
parent case and its nested session-atom-first subtest), eight skips, no
cancellations/TODOs and exit 1. Its log is preserved. After the test-only readiness
fix, the **entire** affected partition was rerun, including neighboring tests.
No production source changed and the other three test partitions were unchanged.
The final production hash check matched the frozen source.

The 35 skips are the runner's unchanged native-platform/prerequisite conditions:
macOS/Windows checks, unavailable X11 development libraries, non-writable
`/dev/uinput`, and a Unicode filename-alias check on a filesystem that distinguishes
the names. The one TODO is the unchanged, unimplemented sync-pagination placeholder
`S5 a full delta page tied on updated_at must not abandon the rest of the pull`.
These are not counted as passes. No skip/TODO declaration was added in the complete
change set. No final shard is incomplete.

[The machine-readable record](participant-scope-suite-results.json) contains exact
commands, raw log paths/SHA-256 hashes, every skip/TODO title, the initial failure,
static-check statuses and the actual totals above. Logs are
`/opt/data/cache/participant-review/gate-shard-{1,2,4}.tap`,
`gate-shard-3-rerun.tap`, and the preserved initial `gate-shard-3.tap`.

The container has a four-CPU cgroup quota and a 512-task limit despite advertising
eight CPUs. Go compiler concurrency and test-file concurrency were bounded; Node
worker-pool defaults were unchanged. No test files were excluded. Discovery runs
stopped for thread exhaustion or superseded fixtures/source are not counted as
final verification. These are Linux ARM64 Node 26.7.0 results; workflow Node 24
and packaged desktop validation remain separate confidence limits.

## Independent review axes

**Standards:** No remaining documented-rule breach was identified. Confirmed
functional inconsistencies were serialization field loss and separate human-lock
predicates; both were fixed. Duplicated unsafe-span predicates remain a maintenance
opportunity, not a reason to change acoustic behavior during this review. Policy
documentation was rewritten to match actual behavior.

**Spec:** The main violations were changing acoustic grouping to enforce display
scope, removing an eligibility case, overstating schema/performance verification,
and treating an intermediate branch failure as a release baseline. Acoustic
identity/routing and public naming now have separate state, with differential
and actual producer-callback regressions. The deleted eligibility case is restored;
old-schema, all completion-path and full-shard evidence replace targeted claims.

## Changelog truth and completeness audit

| 1.13.5 entry                                           | Implemented behavior and regression evidence                                                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic names stay within declared participants      | Global winner first, scope veto second; `speakerRosterPolicy`, `liveSpeakerIdentifier`, `meetingSpeakerReconcile` include outsider C winning without promoting A.                                                         |
| No participants, global voice matching                 | NULL and parsed empty lists ignore linked attendees; `noteSpeakerScope`, `speakerLegacyMigration`, `databaseImport` also preserve undecided unrestricted history. This is not a promise to accept unapproved new matches. |
| Names require voice evidence / participant explanation | `meetingSpeakerReconcile` rejects roster-only and attached-email suggestions; `noteParticipantsEventLink` checks scope/unavailable explanation rendering.                                                                 |
| Unassessed names go to review                          | Main/editor/People migration and review regressions, plus local serialization round trips, preserve Unknown/review classification; restricted legacy candidate names are also removed.                                    |
| People shows missing evidence and correct usage        | Browser labels execute in Chromium; `peopleActions` verifies veto/Unknown usage does not come from stale mappings. Explicit attendance remains separate.                                                                  |
| Corrections keep their scope                           | Correction transactions, replay/store and editor regressions check affected rows, sibling caches and undo after/during roster changes.                                                                                    |
| Human choices survive sync                             | Public serialization/import and fresh-device cloud tests preserve human names and Unknown without transporting local profile IDs or history.                                                                              |
| Rejected matches leave no contact email behind         | `transcriptDocument`, `transcriptSync` and contact-search regressions check rejected identity stripping and stale mapping attendance inference.                                                                           |
| Long transcripts stay responsive                       | Actual 2,000-row completion/editor/committed-batch and heartbeat checks above. Wording no longer claims work is independent of note length.                                                                               |
| Participant edits preserve search                      | Fresh, real old-schema clean/corrupt and repeated-open FTS tests verify search/index integrity through local/cloud roster and text edits.                                                                                 |
| Changing notes preserves the selected tab              | The deterministic deferred-frame NoteEditor regression exercises the user's click before the old note-change frame. This user-visible branch change was previously omitted and now has its own Notes entry.               |

The earlier “same behaviour” promise was narrowed to global matching and preserved
historical attribution. The earlier unqualified growth/performance promise was
replaced with the actual yielding/batching behavior. People usage, inferred
attendance and the note-tab race were added explicitly. No remaining identified
user-visible net change is omitted. Private acoustic state and callback fixes
restore existing recognition/clustering behavior; they do not introduce a new
threshold, calibration or diarisation feature to advertise.

## Owner decisions still required

1. **Should absent participants remain unrestricted when a calendar is linked?**
   Recommendation: use only the note's explicit participant list for naming,
   keeping NULL/empty unrestricted; show a deliberate action to copy calendar
   attendees if the owner wants that restriction. This matches current code,
   but contradicts the branch's earlier policy document. No calendar fallback
   decision should be inferred from a green test.
2. **Should an explicitly listed declined guest or resource remain eligible?**
   Recommendation: treat an explicitly declared list as authoritative, and filter
   calendar attendance noise when creating/copying that list. Current matching
   ignores RSVP/resource metadata; deciding to exclude entries is a product rule.
3. **Should accepted machine names from another device remain visible without
   local acoustic re-evaluation?** Recommendation: preserve portable accepted email
   identity only after unambiguous local identity/current-roster validation, while
   continuing to say that this device did not assess the audio. Imported identity
   must never supersede an existing local veto through serialized proof. Current
   code follows this policy; requiring local audio for every imported name would
   be a different product contract.
4. **How should owners recover the legacy rows newly placed in Review?**
   Recommendation: offer an explicit “Re-evaluate available audio” action that
   uses the existing evaluator/thresholds/private handles, with manual naming
   when audio is unavailable. This review preserves current manual resolution
   and existing re-evaluation paths; that batch recovery UI is not implemented
   and is not promised by the changelog.
