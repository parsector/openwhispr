# 1.13.2 release gate regression

## Evidence and bisection

The requested run ID `42259185454` returns HTTP 404. The actual release run
[`42259185444`](https://github.com/parsector/openwhispr/actions/runs/42259185444)
is accessible and matches `/opt/data/cache/scratch/rel1312_fail.log`. Full logs
were also obtained for the passing
[`42082668004`](https://github.com/parsector/openwhispr/actions/runs/42082668004).

The first-parent sequence was tested before editing implementation or fixtures:

| Revision | Selected tests | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| `73c1b3299` (1.13.1) | 189 | 188 | 0 | 1 |
| `08c3cee1d` (retention merge) | 189 | 161 | 27 | 1 |
| `b455ace18` (both merges and changelog) | 189 | 161 | 27 | 1 |

Selection: both live speaker files; all five named sync files; `noteFieldSync`,
`noteCreateReconciliation`, `anthropicReasoningNetworkError`,
`routineToolRegistry.native`, and `meetingAudioPlaybackChain`. The first two
probes used the installed Node 26; the master probe used CI's Node 24.

A separate automated first-parent bisection used Node 24, with the two speaker
files, the assembly file and playback chain as its predicate:

```sh
git bisect start --first-parent b455ace18 73c1b3299
ELECTRON_OVERRIDE_DIST_PATH=/tmp REQUIRE_DB_TESTS=1 git bisect run \
  node --import tsx --test --test-concurrency=2 --test-reporter=tap \
  test/helpers/liveSpeakerReconsideration.test.js \
  test/helpers/liveSpeakerAnchor.test.js \
  test/helpers/routineToolRegistry.native.test.js \
  test/utils/meetingAudioPlaybackChain.test.js
```

Both tested merges produced `29 tests / 2 pass / 27 fail / 0 skip`.
The same predicate was also run on `73c1b3299` under Node 24 and passed
`29 tests / 29 pass / 0 fail / 0 skip`.
The actual bisect result is:

```text
08c3cee1deb5716c36fca4bf26b1f17e8f3a17cc is the first bad commit
```

The 27 failures include failing nested tests, not 27 independent causes.

## Causes, intended behavior and fixes

### Live speaker reconsideration and anchors

The actual CI assertion is `false !== true` in each fixture's approval loop.
It occurs before the live speaker decision is reached. The preceding warning
is `Voice enrollment decision failed`, code `exemplar_key_unavailable`, at
`voiceEnrollment.js:1009` / `voiceExemplarAudio.js:124-130`.

The retention merge deliberately requires encrypted durable clips, canonical
PCM of the approved duration, and recording provenance. The old fixtures
supplied no encryption, only the four letters `RIFF` as a WAV header, always
returned four seconds even for trimmed 3.5-second requests, and used note IDs
as recording IDs without a manifest provider. Fixing encryption alone would
still fail duration, PCM identity, and provenance requirements
(`voiceExemplarAudio.js:135-136`, `voiceRecordingIdentity.js:75,93,126,140`,
`voiceEnrollment.js:1033-1040,166-185`).

A separate Node 24 in-memory contract probe confirmed the other old-fixture
defects against the unchanged production guard functions: the fixed four-second
buffer fails `durationMatches` for the trimmed 84,000-sample approval; hashing
the incomplete RIFF buffer throws `Expected canonical enrollment PCM WAV`; and
classifying the old status-only store with a cached note/recording ID records
`pending_recovery`. Thus adding an encryption stub alone would not be a valid fix.

The deliberate decision is documented in `docs/voice-exemplar-retention.md:5`:

> Approved clips belong to the person and are saved with their approval in local encrypted storage.

And at line 9:

> An approval records its identity from the real recording manifest in the approval transaction.

> Unknown provenance contributes no recording count, centroid vote, recognition profile or calibration vector.

The obsolete fixture assumption was that approval could succeed with neither
encrypted storage nor real recording provenance. The expectations about live
graduation, uncertainty, cohorts, corrections, centroid stability, and anchor
invalidation remain valid. No existing assertion or expected result changed.
The fixtures now record real encrypted audio through `MeetingAudioStore`, with
the existing test codec and process-local encryption provider.

No production encryption, hash, provenance, eligibility, or final speaker
decision checks were relaxed. Calibration's documented intention was to leave
recognition math and retention unchanged
(`docs/calibration-evidence-integrity-report.md`, Intentional limits); the
revision probes confirm that it introduced none of these failures.

### Playback chain

The CI assertion at `test/utils/meetingAudioPlaybackChain.test.js:99` is actual
`temporary_failure`, expected `gap`. The retention merge added exact coverage
checking at `src/helpers/meetingAudioStore.js:727` (pre-fix), before considering
the pause intervals recorded by `append` at line 389. Thus an intentional stop
and restart interval looked like missing/corrupt chunk coverage.

The product fix at `src/helpers/meetingAudioStore.js:726-729` returns `gap` when
the requested span intersects a recorded pause. It continues refusing partial
audio; missing chunks without a declared pause, duplicated intervals, mismatched
authenticated indexes, and wrong decoded durations retain integrity failures.
The original playback-chain assertion is unchanged. A new regression covers
both sync and async playback, wholly within and across a pause, plus playable
audio on both sides.

### Native routine assembly

CI says `Routine tool assembly is stale; run npm run compile:routine-tools`.
The artifact at `src/helpers/routines/generated/toolAssembly.cjs` bundles i18n
through `productHelpTools.ts:9` and `src/i18n.ts:4`. The retention merge changed
locale strings without regenerating it; calibration changed more locale
strings. Bisection first fails at retention. Rebuilt the committed product
artifact with `npm run compile:routine-tools`; its source parity and native
loading tests are unchanged.

### Sync, note reconciliation and Anthropic

None of `syncScenarios`, `syncServiceNotes`, `syncServiceDictionary`,
`syncServiceConversations`, `syncServiceTranscriptions`, `noteFieldSync`,
`noteCreateReconciliation`, or `anthropicReasoningNetworkError` fails in the
actual CI run or the selected revision probes. Their printed error stacks are
pre-existing handled-error test output, not another regression or an observed
flake. Both release logs contain exactly 76 occurrences of the missing shared
dictionary IPC message, six note revision probe failures and two Anthropic
reasoning errors. Every named file also has the same number of stack references
in both logs. No product or test changes were made to these suites.

## Test change audit

All line numbers below refer to the final files. Existing assertions are
unchanged. Removed malformed WAV/stub lines are replaced by the real store;
there is no replacement expectation that accepts an approval failure.

| File and changed line | Justification |
| --- | --- |
| `liveSpeakerAnchor.test.js:19` | Import the shared retained recording fixture. |
| `liveSpeakerAnchor.test.js:31` | Replace the unencrypted fixed-length WAV stub with the real audio store, retaining the controllable review clock. Removes the old buffer allocation, incomplete RIFF header, waveform loop, and stub status/span methods. |
| `liveSpeakerAnchor.test.js:35` | Create the source recording before constructing its transcript rows. |
| `liveSpeakerAnchor.test.js:38` | Use the recording UUID returned by the manifest instead of the note ID. |
| `liveSpeakerReconsideration.test.js:21` | Import the same fixture. |
| `liveSpeakerReconsideration.test.js:32` | Replace the same malformed, unencrypted fixed-length stub; preserve the review clock. |
| `liveSpeakerReconsideration.test.js:36` | Record each historical meeting before constructing rows. |
| `liveSpeakerReconsideration.test.js:39` | Persist its real recording UUID. |
| `test/lib/retainedSpeakerAudio.js:1` | Resolve recording storage below each fixture's temporary directory. |
| `retainedSpeakerAudio.js:2` | Use production recording construction and sample rate. |
| `retainedSpeakerAudio.js:3` | Use existing authenticated test encryption without host keychain access. |
| `retainedSpeakerAudio.js:4` | Use existing deterministic codec without external FFmpeg. |
| `retainedSpeakerAudio.js:6-7` | Explain the contract exercised by this fixture. |
| `retainedSpeakerAudio.js:8` | Accept each test's real database, isolated directory and clock. |
| `retainedSpeakerAudio.js:9-11` | Construct the real store with those dependencies. |
| `retainedSpeakerAudio.js:12` | Cancel unrelated startup recovery work in this fresh, isolated fixture. |
| `retainedSpeakerAudio.js:13-14` | Expose the store for the existing review/play/approval calls. |
| `retainedSpeakerAudio.js:15` | Expose recording creation for historical meetings. |
| `retainedSpeakerAudio.js:16` | Allocate five seconds per row, preserving the original row spacing and four-second row intervals. |
| `retainedSpeakerAudio.js:17-18` | Generate the same clean sine-wave PCM used by the old fixtures. |
| `retainedSpeakerAudio.js:19` | Begin a recording and obtain its actual manifest UUID. |
| `retainedSpeakerAudio.js:20` | Append to the correct system cohort through production encryption/chunking. |
| `retainedSpeakerAudio.js:21` | Flush the recording so approval can read complete source intervals. |
| `retainedSpeakerAudio.js:22` | Return the UUID for transcript provenance. |
| `retainedSpeakerAudio.js:23-25` | Close the record function, fixture result, and module export. |
| `meetingAudioStore.test.js:135` | Name the new pause regression and use async testing for both entry points. |
| `meetingAudioStore.test.js:136-137` | Use the existing isolated database/store fixture. |
| `meetingAudioStore.test.js:138-140` | Record and finish one second of microphone audio. |
| `meetingAudioStore.test.js:141` | Advance the existing fixture clock to introduce a two-second pause. |
| `meetingAudioStore.test.js:142-144` | Resume and finish another second, using the production pause writer. |
| `meetingAudioStore.test.js:145` | Prove the pause was deliberately recorded, rather than deleting or fabricating chunks. |
| `meetingAudioStore.test.js:146` | Exercise both a request wholly in the pause and a request crossing it. |
| `meetingAudioStore.test.js:147` | Require synchronous playback to explain the refusal as a gap. |
| `meetingAudioStore.test.js:148` | Require the same result from asynchronous playback. |
| `meetingAudioStore.test.js:149` | Close the two-range check. |
| `meetingAudioStore.test.js:150` | Verify the first recording remains playable through the sync API. |
| `meetingAudioStore.test.js:151` | Verify resumed audio remains playable through the async API. |
| `meetingAudioStore.test.js:152` | Close the regression test. |

Other changed ranges: `src/helpers/meetingAudioStore.js:726-729` is the product
gap classification. The regenerated `toolAssembly.cjs` changes lines 1, 102,
130, 132, 142, 151, 155, 157, 159, 813, 861, 909, 957, 1005, 1053, 1101, 1149,
1197, 1247, 1295, 1308-1309, 1311, 1317, 1362-1363, 1365, 1367-1368, 1409,
1415 and 1425. This report is a new documentation file.

## Validation

Node 24.22.2 matches the release workflow's Node 24 major. The `better-sqlite3`
binding was rebuilt for it. The original dependency link and Node 26 binding
are restored after validation. Four shards follow `.github/workflows/release-fork.yml`.
CPU affinity limits each invocation to two cores to fit this container. The
complete invocation for each shard is:

```sh
NODE_OPTIONS="--test-shard=$shard/4 --test-reporter=tap" \
  ELECTRON_OVERRIDE_DIST_PATH=/tmp REQUIRE_DB_TESTS=1 \
  taskset -c "$cpus" npm test
```

`shard` is 1, 2, 3, 4, with `cpus` respectively 0,1; 2,3; 4,5; 6,7.
During the before run, the first two task-owned process trees were moved to
cores 4,5 and 6,7 respectively after discovering the host's heterogeneous CPU
layout. The after run uses 4,5; 6,7; 4,5; 6,7 from its start. This only changes
CPU scheduling, not test selection or assertions. Each after shard runs in the
isolated `.bisect-release` worktree as soon as its corresponding before shard
finishes, keeping at most four full-suite runners active. Its code and generated
assembly are compared byte-for-byte with the final master files before commit.
The PATH selects the downloaded Node 24 binary. Flags are set before the script
because appending them after the test glob did not shard the first attempted
run. Initial attempts with Node 26 or excessive parallelism were stopped and
are excluded from the completed-run totals.

Original complete CI totals (from the downloaded logs, including the passing
shard omitted by `--log-failed`):

| Run / shard | Tests | Pass | Fail | Skip | Todo | Cancelled |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1.13.1 / 1 | 2996 | 2982 | 0 | 14 | 0 | 0 |
| 1.13.1 / 2 | 2892 | 2885 | 0 | 6 | 1 | 0 |
| 1.13.1 / 3 | 2576 | 2570 | 0 | 6 | 0 | 0 |
| 1.13.1 / 4 | 2908 | 2899 | 0 | 9 | 0 | 0 |
| **1.13.1 total** | **11372** | **11336** | **0** | **35** | **1** | **0** |
| 1.13.2 gate / 1 | 2834 | 2815 | 0 | 19 | 0 | 0 |
| 1.13.2 gate / 2 | 2840 | 2830 | 2 | 7 | 1 | 0 |
| 1.13.2 gate / 3 | 3092 | 3077 | 12 | 3 | 0 | 0 |
| 1.13.2 gate / 4 | 2727 | 2708 | 13 | 6 | 0 | 0 |
| **1.13.2 gate total** | **11493** | **11430** | **27** | **35** | **1** | **0** |

Completed local before run at `b455ace18`:

| Shard | Tests | Pass | Fail | Skip | Todo | Cancelled |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2834 | 2815 | 0 | 19 | 0 | 0 |
| 2 | 2840 | 2830 | 2 | 7 | 1 | 0 |
| 3 | 3092 | 3077 | 12 | 3 | 0 | 0 |
| 4 | 2727 | 2708 | 13 | 6 | 0 | 0 |
| **Total** | **11493** | **11430** | **27** | **35** | **1** | **0** |

Completed local after run, on `f43fac6af` plus this fix:

| Shard | Tests | Pass | Fail | Skip | Todo | Cancelled |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2834 | 2815 | 0 | 19 | 0 | 0 |
| 2 | 2840 | 2832 | 0 | 7 | 1 | 0 |
| 3 | 3092 | 3089 | 0 | 3 | 0 | 0 |
| 4 | 2728 | 2722 | 0 | 6 | 0 | 0 |
| **Total** | **11494** | **11458** | **0** | **35** | **1** | **0** |

All four after invocations exited 0. The extra test is the new recorded-pause
regression in shard 4. All 27 original failures are resolved. After completion,
all six changed code, assembly and test files were again compared byte-for-byte
with master and matched. No existing assertion changed.

The new pause regression was run red before changing product code: 42 tests,
41 passed, 1 failed, 0 skipped. The real failure was `temporary_failure` with
reason `source_integrity_failed`, where `gap` was expected. Both repaired live
speaker fixtures already passed in that run.

Focused verification after the fix: 119 tests, 119 passed, 0 failed, 0 skipped.
This included the two speaker files, `meetingAudioStore`, `voiceExemplarAudio`,
the routine assembly file and the original playback chain. Missing coverage,
authenticated index mismatches and short/long decoded chunks still refuse
enrollment recovery. `npm run lint` exited 0.

```sh
ELECTRON_OVERRIDE_DIST_PATH=/tmp REQUIRE_DB_TESTS=1 \
  node --import tsx --test --test-concurrency=2 --test-reporter=tap \
  test/helpers/liveSpeakerReconsideration.test.js \
  test/helpers/liveSpeakerAnchor.test.js \
  test/helpers/meetingAudioStore.test.js \
  test/helpers/voiceExemplarAudio.test.js \
  test/helpers/routineToolRegistry.native.test.js \
  test/utils/meetingAudioPlaybackChain.test.js
```

Artifacts outside the commit:

- `/tmp/ow-release-131.log`, `/tmp/ow-release-132.log`: complete original CI logs.
- `/tmp/ow-bisect-baseline.tap`, `/tmp/ow-bisect-retention.tap`,
  `/tmp/ow-bisect-master.tap`: three-revision probes.
- `/tmp/ow-git-bisect.log`: automated first-parent bisection.
- `/tmp/ow-bisect-good-node24.tap`: passing Node 24 bisection baseline.
- `/tmp/ow-approval-contract-probe.log`: independent old-fixture duration, PCM and provenance probes.
- `/tmp/ow-fixtures-and-gap-red.tap`: regression before the product fix.
- `/tmp/ow-focused-after.tap`, `/tmp/ow-lint.log`: focused and static checks.
- `/tmp/ow-restore-dependencies.log`: restoration of the original Node 26 binding.
- `/tmp/ow-before-{1,2,3,4}.tap`, `/tmp/ow-after-{1,2,3,4}.tap`: full-suite shards.

Remote master already contained `f43fac6af` (`chore(release): v1.13.2`) when
fetched. The fix preserves that upstream version commit. This change does not
edit either dependency manifest, create a tag, or initiate a release.
