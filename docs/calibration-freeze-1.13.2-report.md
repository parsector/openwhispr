# Calibration freeze in 1.13.2

Investigated from `master` at shipped commit `d50e80bc0`. No owner database,
recordings, credentials, or running application were accessed. The applicable
parent `AGENTS.md` was read; this checkout has no additional `AGENTS.md`.

## Mechanism

**The reproduced freeze is synchronous evidence collection in Electron's main
thread, dominated by a row × approval × recording-chunk metadata scan.** It
happens before re-embedding starts. Synchronous decoding adds later stalls and
repeated work, but is not needed to reproduce the initial freeze.

References in this subsection are to **`d50e80bc0`**, not the edited line numbers:

| Candidate                    | Evidence and conclusion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main-thread work             | `src/helpers/ipcHandlers.js:3338–3340` calls `runJob` from `setImmediate` in the main process. `setImmediate` defers execution; it does not move execution to another thread. `src/helpers/speakerInAppCalibration.js:464–474` calls synchronous `collectRows` before its first await. At `:360–374`, **every transcript label** scans the approval library with `.some()`. This also happens before the row-budget check at `:385`.                                                                                                                                                                                                                                                                                                                                              |
| What consumes the time       | Each pair calls `overlapsRecording` (`src/helpers/voiceRecordingIdentity.js:178–195`). Both provenance lookups run **before** checking track, bounds, or whether the recordings differ. The current-note lookup calls `store.recordingProvenance` through `classifyEvidence` (`:156–160`). `src/helpers/meetingAudioStore.js:592–602` reloads the recording manifest; `:249–275` validates **every indexed chunk path**. `_chunkFile` at `:277–294` performs directory/file filesystem checks. Thus even an unrelated approval causes another whole-manifest parse and traversal. This is metadata/filesystem work, invisible in a count of re-embedded bytes. The 2,216-row reproduction made 193,026 provenance reads and blocked the main loop for 279.7 seconds.              |
| Locks/transactions           | This reproduction has no concurrent writer, recovery queue, held transaction, or calibration mutex. `collectRows` and `runJob` contain no enclosing transaction. The job marker at `ipcHandlers.js:3312–3337` is an in-memory object, not an awaited lock. Startup recovery yields through its scheduler (`src/helpers/voiceEnrollmentRecovery.js:411–477`); its approval transaction (`:377`) follows asynchronous source work (`:221`), rather than enclosing that await. Recovery can add load, but is not necessary for this freeze. This does not assert that an unrelated external writer can never delay SQLite on the owner's machine.                                                                                                                                    |
| Missing event/completion     | Before the first await, no inference completion or worker event is being awaited. Progress and cancel are main-process IPC handlers (`ipcHandlers.js:3353–3366`); they cannot run while collection occupies that thread. ONNX extraction already goes through a utility process (`src/helpers/speakerEmbeddings.js:94–116`); ordinary requests have a 30-second deadline and worker-exit rejection (`src/helpers/onnxWorkerClient.js:131–151,233–245`). Its spawn wait (`:64–85`) has no explicit deadline, so a separate startup failure was not universally ruled out. It did not occur in this reproduction, which freezes with stubbed asynchronous inference and also when cancelled before any inference. The fix adds an enclosing calibration deadline for this boundary. |
| Per-row whole-recording work | Confirmed for **metadata** in the overlap test above, and again in ordinary span manifest validation. Whole-recording **audio** decoding is not occurring: calibration requests at most eight seconds (`speakerInAppCalibration.js:526`), and `_spanSteps` reads only intersecting five-second chunks (`meetingAudioStore.js:735–764`). But calibration calls the synchronous `span`, which invokes `codec.decode` (`:653–665`), implemented with `spawnSync` (`:103–115`). Neighbouring rows decode the same chunks repeatedly. This makes the later phase slower and intermittently blocks the main thread; it is distinct from the long initial collection block.                                                                                                              |

This distinguishes an occupied thread from an idle thread awaiting a missing
event: the small cancellation reproduction consumed 11.09 seconds before even
delivering a 5-ms cancellation timer; the larger reproduction eventually left
collection and completed. An isolated 10,000-row run delivered **zero** heartbeats
or processed-row progress during a 60-second external watchdog observation.
We did not reproduce the owner's exact hour or inspect his actual approval and
chunk distribution. The shipped mechanism is proven; attributing his particular
incident to it remains an inference pending testing his library.

Authoritative profile reconstruction is called once after the row loop
(`d50e80bc0:src/helpers/speakerInAppCalibration.js:555–559`), not once per row.
The initial freeze therefore does not come from per-row profile rebuilding or
synchronous ONNX execution in the main process.

## Why previous verification missed it

The reported 1,055 re-embeds in roughly 110 seconds over 41 MB measures embedding
throughput, not responsiveness or the uncounted metadata work before embeddings.
The transcript/approval cross product does not depend on embedding throughput.

The checked-in benchmark is explicit about its boundary:
`scripts/fixtures/benchmark-in-app-calibration.js:49–91` decodes its three clips
before starting the timer at `:96`; its measured loop directly runs inference,
then calls `buildReport` (`:124`). It never calls `collectRows`, never constructs
an enrolled approval library and retained chunk manifests, and does not measure
main-loop heartbeats, delivery of progress, or cancellation. The limitations are
also documented in `docs/speaker-calibration-benchmark.md:9`. Existing job tests
use tiny database/audio mocks. Correct scores and a finite inference runtime
therefore did not test this liveness property.

## Fix and bounds

- File-backed application jobs dispatch to a Node worker through
  `src/helpers/speakerInAppCalibration.js:669`. Collection, manifest validation,
  decryption, PCM conversion, hashing, authoritative profile reconstruction,
  sweep and admission computation all execute there. Small in-memory unit mocks
  retain the local engine. ONNX keeps its existing utility-process lifecycle;
  the main thread only forwards embedding requests and replies.
- `src/workers/calibrationWorker.js:84` obtains a consistent snapshot with the
  SQLite **online backup API**, closes the live reader, and opens the snapshot
  read-only. It bypasses database/store constructors, so it cannot run migrations,
  recovery, retention or approval writes. No standalone WAL-file copy is used.
- `src/helpers/calibrationEvidenceIndex.js:42` indexes approved row IDs and
  recording/note/track intervals once. Ineligible and unresolved approvals still
  suppress the same fallback rows. Overlap queries use sorted starts and prefix
  maxima, preserving nested intervals and strict boundary comparisons. Provenance
  is resolved once per sample and once per note. Legacy/durable deduplication in
  `voiceEnrollment.samples` now uses a set instead of another nested library scan.
- `speakerCalibrationExport` indexes actions once; `meetingAudioSpan.mjs:14`
  supplies bulk next-row lookup and recorded regions, preserving player timing
  without rescanning the remainder of the transcript for every label.
- `src/helpers/calibrationAudioSession.js:10` caches validated manifests and
  indexes source chunks once. Each row selects only intersecting chunks and uses
  asynchronous decoding. An overlapping source is decoded once per recording;
  compressed inputs and decoded PCM have separate 32-MiB memory budgets. PCM
  evicted from memory is encrypted into private disposable spill files, rather
  than decoded again. Work is grouped by note; audio caches are discarded at the
  note boundary. Evidence/report order is retained. The existing eight-second
  embedding cap and 10,000-row application budget remain in force.
- `src/helpers/calibrationWorkerClient.js:13` handles worker errors **and exits
  without completion**, publishes progress during collection and per row, and
  updates elapsed time while awaiting work. An embedding reply has a 35-second
  calibration deadline; a silent worker has a 60-second deadline. Cancel aborts
  an active asynchronous decoder and terminates the disposable worker, including
  during synchronous collection or report construction. The existing renderer
  polls progress every 400 ms (`src/components/settings/PeoplePage.tsx:386–400`).
- Report freshness checking also runs in a worker (`speakerInAppCalibration.js:684`).
  It indexes exemplars once, and compares database change markers before and after
  validation so concurrent database changes cause refusal rather than applying
  stale evidence.

The policy module is unchanged: `speakerCalibrationPolicy.js:11–12` still
requires 0.70 correct-name coverage and 0.90 precision. The admission criteria,
sweep candidates/scoring, evidence checks, and requirement for an independently
supported recommendation are unchanged. A diagnostic report cannot become a
recommendation through this fix.

## Cancellation, interruption and restart

Calibration writes neither library evidence nor thresholds. Completed rows are
temporary diagnostics, not half-applied training data. A cancelled or failed job
can be restarted from the beginning; this is **restartability**, not a persisted
checkpoint/resume feature. Applying a supported report remains a separate action.

The old job marker is memory-only, so a force quit cannot leave a persistent
calibration lock or marker to repair. No library repair is justified by this
freeze. New runs may leave disposable snapshots or encrypted PCM cache after a
process crash. On next launch, IPC registration runs
`calibrationWorkerClient.recover` (`ipcHandlers.js:3313`) before permitting work,
removing only the dedicated sibling `<meeting-audio-root>.calibration-jobs`
directory. Normal completion, failure and cancel also terminate the worker and
remove its private run directory. The regression verifies restart without any
additional SQLite writes, removal of an orphan snapshot, and early worker-exit
handling.

## Measurements

Linux arm64, Node 26.7.0. Fixture construction is outside the job timer. Both
corpora have 34 actual SQLite notes, 30 people with three durable approvals each,
AES-GCM encrypted retained chunks, and two-second reviewed transcript rows. The
2,216-row corpus produces 2,182 selected evidence rows; the 10,000-row corpus
produces 9,966. The 34-row difference is the existing overlap-suppression rule
around approved intervals, and is identical before/after. Input corpus sizes
are 2,216 and 10,000; row admission was not weakened to increase those counts.

This is an isolated **liveness** fixture, not an acoustic benchmark. It uses the
real database, approval/provenance readers, encrypted store, span selection, PCM
conversion, job engine and report/policy builder. Compression/decompression uses
the existing deterministic test codec; inference is an asynchronous deterministic
512-dimensional stub. All silent chunks share codec bytes, so the cache can
reuse one decoded payload per recording (34 decodes). Real speech has more unique
payloads, bounded by the selected source chunks. These timings must not be used
to predict real ONNX/FFmpeg total runtime or recommendation quality.

| Corpus/run                |             Wall time | Longest main-loop stall |          Moving processed-row ticks |  Peak RSS |
| ------------------------- | --------------------: | ----------------------: | ----------------------------------: | --------: |
| Shipped, 2,216            |             286.415 s |            279,697.3 ms | 1,103, **all after initial freeze** | 218.2 MiB |
| Shipped, 10,000, watchdog | ≥60.007 s, terminated |            ≥60,002.1 ms |                               **0** | 215.0 MiB |
| Fixed, 2,216              |               3.367 s |                 10.1 ms |                                 415 | 295.3 MiB |
| Fixed, 10,000             |              12.207 s |                 15.2 ms |                               1,649 | 463.4 MiB |

The final two runs temporarily paused only this task's broad test processes to
avoid competing test CPU; those processes were then resumed. Heartbeat interval
is 5 ms; reported stall subtracts that nominal interval. Peak RSS includes
fixture construction and all threads in the process, using the OS high-water
mark as well as sampled RSS. It is not just V8 heap. Main-thread CPU between
heartbeat samples peaked at 15.4 ms and 17.7 ms respectively. Progress events
published by the worker numbered 2,264 and 10,116. The fixed runs made 34
provenance reads each, versus 193,026 in the shipped 2,216-row run. They read 856
and 3,978 intersecting source chunks respectively, without per-row whole-source
decode.

Concurrent test/build stress runs also recorded wall heartbeat gaps of 50.5–83.9
ms. One instrumented 50.5-ms gap run had a maximum main-thread CPU slice of 13.2
ms. Host scheduling delay is not a policy CPU stall. The regression therefore
checks execution in a worker, published progress and a <50-ms main-thread CPU
slice, while the standalone harness records wall lag separately. The two
uncontended wall measurements above are below 50 ms; this is not a guarantee
about arbitrary OS scheduling pauses.

Active cancellation was requested after at least ten processed rows, rather
than merely cancelling before worker startup:

| Corpus        | Rows processed at cancellation | Cancel to worker teardown/cleanup | Wall time to cancelled result | Longest main-loop stall | Moving progress ticks |  Peak RSS |
| ------------- | -----------------------------: | --------------------------------: | ----------------------------: | ----------------------: | --------------------: | --------: |
| Fixed, 2,216  |                             11 |                           45.0 ms |                       1.273 s |                  5.9 ms |                    11 | 209.6 MiB |
| Fixed, 10,000 |                             10 |                           39.5 ms |                       3.226 s |                 13.9 ms |                    11 | 250.8 MiB |

The IPC cancel handler itself returns without awaiting that teardown. In the
340-row shipped minimization, a cancel due at 5 ms was not delivered for
11,103.5 ms; it processed zero rows and performed 24,186 provenance reads. In the
10,000-row external-watchdog run, cancel was still unserviceable after at least
60,002.1 ms. A completed shipped 2,216-row cancellation run was not measured;
the observed 279.7-second initial block prevents IPC cancellation during it.

Reproduction commands:

```sh
node scripts/fixtures/calibration-liveness.js 2216 --baseline
node scripts/fixtures/calibration-liveness.js 10000 --watchdog
node scripts/fixtures/calibration-liveness.js 2216
node scripts/fixtures/calibration-liveness.js 10000
node scripts/fixtures/calibration-liveness.js 2216 --cancel --active
node scripts/fixtures/calibration-liveness.js 10000 --cancel --active
```

`--baseline` extracts **all** shipped source dependencies with `git archive` into
ignored `node_modules/.cache/calibration-baseline-d50e80bc0`; it does not replace
working files. The watchdog uses a separate process, sends cancel after 5 ms,
samples RSS externally and terminates after 60 seconds. The censored 10,000-row
run proves starvation, not a full before-fix completion time. An earlier ordinary
10,000-row baseline was also stopped after 10 minutes; no completion-time claim
is made for it.

## Verification and remaining limits

The original regression failed with real output:

```text
node --test test/helpers/calibrationLiveness.test.js
✖ calibration delivers progress and services the main event loop during evidence collection
AssertionError: main thread blocked for 279697.3 ms
tests 1, pass 0, fail 1
```

The final regression additionally asserts actual worker execution and emitted
progress, rather than relying on an overall timeout. It tests active cancel,
restart/no library writes, interrupted-run cleanup, unexpected worker exit, and
encrypted cache spill without a second decode. Differential tests compare
indexed suppression with the original `overlapsRecording`, and indexed timing
with the existing player resolver. Existing precision, coverage, refusal,
independent-session and no-evidence admission tests remain required.

Commands and recorded results (local logs are ignored artifacts):

```sh
node --import tsx --test test/helpers/calibrationLiveness.test.js test/helpers/calibrationSpanContext.test.js test/helpers/calibrationEvidenceIndex.test.js test/helpers/speakerCalibration.test.js test/helpers/speakerInAppCalibration.test.js test/helpers/speakerCalibrationAdmission.test.js test/helpers/meetingAudioStore.test.js test/helpers/meetingAudioTimeline.test.js test/helpers/meetingAudioCodecDeadline.test.js test/helpers/voiceExemplarAudio.test.js
# tests 157; pass 157; fail 0; cancelled 0
# node_modules/.cache/calibration-freeze-targeted-final.log

node --import tsx --test test/helpers/debugLogger.test.js test/helpers/debugLoggerConsolePolicy.test.js test/helpers/secretCryptoBackup.test.js test/helpers/voiceEnrollment.test.js test/helpers/calibrationSpanContext.test.js test/helpers/calibrationLiveness.test.js
# tests 74; pass 74; fail 0; cancelled 0
# node_modules/.cache/calibration-freeze-dependency-tests.log

node --import tsx --test test/components/connectorsSection.test.js test/components/conversationListSourceNote.test.js
# tests 43; pass 43; fail 0; cancelled 0
# node_modules/.cache/calibration-freeze-ui-rerun.log

npm run lint
# eslint . --max-warnings=0 && cd src && eslint . --max-warnings=0
# exit 0; node_modules/.cache/calibration-freeze-lint-final.log

npm run typecheck
# cd src && tsc --noEmit
# exit 0; node_modules/.cache/calibration-freeze-typecheck.log

npm run build:renderer
# built in 7.65s (existing large-chunk warning); exit 0
# node_modules/.cache/calibration-freeze-build.log
```

Prettier checked all changed files successfully, and `git diff --check` passed.
The committed raw measurement artifact is
`docs/calibration-freeze-1.13.2-measurements.json`.

`npm test` was also attempted, then stopped: 524 passed, two Vite module-transport
timeouts, 1,051 cancelled. Pausing that task-owned run during uncontended timing
invalidated the two 60-second module-loader deadlines. Its log is
`node_modules/.cache/calibration-freeze-full-tests.log`; both affected test files
passed all 43 tests when rerun without pausing, as shown above. **There is no local
full-suite pass claim.** The full suite remains for the gate. All temporary test
pauses were resumed before stopping that invalidated run; no service or production
process was paused, restarted or deployed.

Unverified: the owner's library and approval/chunk distribution; real Electron
window interaction/repaint on macOS; macOS credential access from the worker;
packaged ASAR/native-addon execution; actual ONNX + FFmpeg end-to-end wall time
and memory. The local Electron executable cannot start because the host lacks
`libgtk-3.so.0` (exit 127). Node worker integration and a test forbidding Electron
API imports inside the worker pass, but do not substitute for that platform gate.
The native keychain fallback reads an existing key only; it never creates or
replaces a key. Already-unlocked keys are copied privately to the worker.

No version bump, tag, release, deploy or production restart is part of this change.

## Changed files and diff ranges

Ranges refer to the new source; “new” means the entire file was added. The policy,
threshold application and recommendation-action modules have no changes.

| File                                               | New-side diff ranges            |
| -------------------------------------------------- | ------------------------------- |
| `src/helpers/calibrationAudioSession.js`           | new, 1–119                      |
| `src/helpers/calibrationEvidenceIndex.js`          | new, 1–73                       |
| `src/helpers/calibrationWorkerClient.js`           | new, 1–119                      |
| `src/workers/calibrationWorker.js`                 | new, 1–175                      |
| `src/helpers/database.js`                          | 42–43                           |
| `src/helpers/debugLogger.js`                       | 4–5, 75                         |
| `src/helpers/secretCrypto.js`                      | 4–5, 208–210                    |
| `src/helpers/ipcHandlers.js`                       | 3313–3317, 3344–3353, 3378–3381 |
| `src/helpers/meetingAudioSpan.mjs`                 | 12–73, 105–108, 132–133, 159    |
| `src/helpers/meetingAudioStore.js`                 | 6, 180, 679, 683–692, 750–760   |
| `src/helpers/speakerCalibrationExport.js`          | 4–7, 50–85                      |
| `src/helpers/speakerInAppCalibration.js`           | 5, 254–424, 447–557, 597–705    |
| `src/helpers/voiceEnrollment.js`                   | 141–150                         |
| `scripts/fixtures/calibration-liveness.js`         | new, 1–86                       |
| `test/lib/calibrationLivenessFixture.js`           | new, 1–255                      |
| `test/helpers/calibrationLiveness.test.js`         | new, 1–119                      |
| `test/helpers/calibrationEvidenceIndex.test.js`    | new, 1–90                       |
| `test/helpers/calibrationSpanContext.test.js`      | new, 1–67                       |
| `test/helpers/voiceExemplarAudio.test.js`          | 30                              |
| `docs/calibration-freeze-1.13.2-measurements.json` | new, 1–97                       |
| `docs/calibration-freeze-1.13.2-report.md`         | new, entire report              |
