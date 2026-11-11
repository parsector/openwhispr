> Historical run report. Current guarantees and corrected baseline claims are in
> [the participant-scope self-review](participant-scope-self-review.md).

# Automatic speaker attribution: fix run 5

Baseline: `master` at `73fd1a59ab75c144945bfb3ed9086683fb74fb3e`.

The main process and renderer import the same implementation:

```js
resolveAutomaticSpeaker(row, storedDecision, scope, incoming,
  { restorationRowIds = [] } = {}) -> row
```

The implementation is `src/helpers/automaticSpeakerAttribution.js:102`. Human attribution, including explicit Unknown and manually named outsiders, remains authoritative. Restoration can release an existing human lock only on the action's affected rows. It cannot override a machine veto. The renderer also ignores response rows outside that affected set. `restoreDecisions` has been removed from the production API.

## Supersession rule

An incoming automatic acceptance can supersede a machine veto only when all of these hold (`automaticSpeakerAttribution.js:70`):

1. The evaluation names this durable row id and the exact previous decision id, and has a different, nonempty decision id.
2. Its canonical audio content hash is nonempty and matches the incoming row's content hash.
3. It matches the row's previously recorded content hash (or the previous evaluation's hash). For legacy rows without a stored hash, both the incoming span and the evaluation's source span must equal the original span exactly; the evaluation producer reads that original retained audio and computes the hash. Changing a recording id, track, or sample boundary cannot establish freshness.
4. The evaluation's roster revision and scope revision equal the incoming decision's, and the decision is current for the note.
5. The winning profile's nonempty fingerprint equals the evaluation fingerprint and the decision's profile fingerprint. The main-process installation also checks it against the current profile library.
6. The accepted identity is eligible in the current scope and the incoming row passes the existing span safety rules.

`src/helpers/speakerRowEvaluation.js:25` reads the row's canonical recording and span, decodes it to the samples used for embedding, computes SHA-256 over those samples, and supplies the embedding and previous decision id. Enrollment/profile changes and roster changes schedule this evaluation; cached centroids cannot supply its proof. Unavailable audio leaves the veto standing. Reconsideration publishes assignments and updates identifier mappings only for rows admitted by the boundary and present in the committed result.

No threshold, diarisation algorithm, cohort ranking, calibration, enrollment policy, retention, mobile, version, or changelog changes were made.

## Every direct boundary call site

Line numbers refer to this fix's source files, under `src/`.

| Call site | Purpose |
| --- | --- |
| `helpers/noteSpeakerScope.js:143` | Main commit/read/import validation against stored rows, including parent lineage |
| `helpers/noteSpeakerScope.js:148` | Pass human rows through the same boundary |
| `helpers/speakerAssignmentPolicy.js:55` | Shared provisional, confirmed, and suggested automatic updates |
| `helpers/liveSpeakerReconsideration.js:204` | Clean-cluster and fresh row reconsideration results |
| `helpers/ipcHandlers.js:15052` | Retroactive mapping, with the same fresh row evidence producer |
| `helpers/transcriptDocument.js:398` | Sync merge of an existing local row |
| `helpers/transcriptDocument.js:453` | New automatic transcript rows |
| `helpers/transcriptDocument.js:460` | Automatic transcript merge with stored attribution/parent lineage |
| `utils/transcriptSpeakerState.ts:74` | Renderer row normalization, parsing, and serialization |
| `utils/transcriptSpeakerState.ts:107` | Renderer speaker patches |
| `utils/transcriptSpeakerState.ts:190` | Matched renderer final merge |
| `utils/transcriptSpeakerState.ts:241` | Renderer final split-child lineage |
| `utils/transcriptSpeakerState.ts:338` | Restoration of an action's existing affected rows |
| `utils/transcriptSpeakerState.ts:348` | New rows accompanying a restoration response |
| `stores/meetingRecordingStore.ts:721` | Identification events and cached-window replay |
| `stores/meetingRecordingStore.ts:1697` | Cluster merge attribution |
| `stores/meetingRecordingStore.ts:2287` | Committed rows: note updates, reconsideration, corrections, split, undo, and live restoration |
| `stores/meetingRecordingStore.ts:2563` | Delayed final completion against the persisted note scope |
| `stores/meetingRecordingStore.ts:2617` | Final completion retry after an optimistic-write conflict |

The main adapters are database commit/read (`helpers/database.js:4473`, `:4695`), final send including skipped/failed diarisation (`helpers/ipcHandlers.js:15397`), and correction/split/undo validation (`helpers/speakerCorrectionTransaction.js:369`). Sync import resolves portable identity inside `enforceRows` and then uses the boundary. The live NoteEditor response uses `mergeCommittedSpeakerRows` with `result.affectedRowIds` (`components/notes/NoteEditor.tsx:954`); the stopped editor uses `restoreTranscriptSpeakerRows` with the current note (`:964`). `assignLiveSpeakerRows` delegates supplied response rows to that same scoped commit path. Cache restoration no longer fabricates a rejection from an absent mapping.

## Root causes and regressions

Baseline locations below are at `73fd1a59a`.

| Defect | Baseline root cause | Fix and observed red → green behavior |
| --- | --- | --- |
| 1. Late final replay | `meetingRecordingStore.ts:2541` called the renderer merge at `transcriptSpeakerState.ts:117`; `transcriptDocument.js:439` preserved human/approved names but did not consult a stored machine veto. `ipcHandlers.js:15389` could send cached skipped/failed rows. | Both merges, both final-completion attempts, and the main final send consult the boundary with stored rows. Identical-id/span cached A became Unknown; skipped and failed sends retain the prior veto. Split-child regressions also preserve parent vetoes without changing child spans. |
| 2. Sibling cache loss | `meetingRecordingStore.ts:2333` replaced an entire shared window from one changed row. `:2413` inferred a cluster-wide rejection from an absent human mapping. | Cache windows partition at affected row/sample bounds; untouched intervals retain their own names, decisions, and cluster ids. Merge/reconsideration callbacks no longer overwrite cache names cluster-wide. The baseline shared-window split moved the sibling to Unknown/split cluster; the fixed path keeps sibling A in its original cluster, including after mapping removal. |
| 3. Coordinate-only supersession | `meetingRecordingStore.ts:2304` treated any coordinate inequality plus a new decision id/current roster as new audio. | The shared provenance rule above replaces coordinate inequality. Baseline track-only, recording-only, and one-sample changes all displayed A; all are refused. Wrong content/profile hashes are refused. A fresh evaluation of the same canonical audio and current roster/profile succeeds in main and renderer/store tests. |
| 4. Reconsideration stuck / retroactive escape | `liveSpeakerReconsideration.js:80` excluded every rejected row; `ipcHandlers.js:14986` could install accepted cached-cluster evidence over a veto. | Changed roster/profile evidence schedules extraction of the original row audio. Before successful fresh evaluation, the veto stands. Enrollment and roster-expansion regressions changed from zero assignments to a committed name. Cached retroactive mapping and reconsideration now agree on preserving the same veto. A retained-audio integration test verifies the committed sample hash. A refused row cannot publish an accepted cluster assignment. |
| 5. Undo outsider response | `speakerCorrectionTransaction.js:370` validated the database write but `:411` returned the earlier serialized rows. `NoteEditor.tsx:949` installed the full response using an unrestricted restoration flag. | The transaction validates restoration against the current roster and returns the committed transcript at `speakerCorrectionTransaction.js:423`, plus the exact affected ids. Undo after A→B returns exactly the persisted Unknown/roster_changed rows. Live and stopped NoteEditor tests never install stale A, including a participant change during the IPC wait; unrelated response rows cannot bypass their vetoes. |

All four human lock representations (`speakerLocked`, user `speakerLockSource`, `locked`, `user_locked`) remain covered, including explicit Unknown and manually naming an outsider.

## Demonstrated baseline failures

Regressions were first run before the production edits, then copied to a detached baseline worktree at `/opt/data/cache/scratch/run5/baseline` so later Vite loads could not accidentally use edited production files. The consolidated baseline command was:

```sh
node --import tsx --test --test-reporter=tap \
  --test-name-pattern='late accepted final|main skipped final|main failed final|coordinate-only|splitting one accepted|undo after roster change returns|row supersession requires|a veto is reevaluated|retroactive cached mapping|NoteEditor.*undo|restoration cannot bypass|reconsideration with fresh canonical|final split child|renderer final respects' \
  test/helpers/meetingSpeakerReconcile.test.js \
  test/helpers/liveSpeakerReconsideration.test.js \
  test/helpers/noteSpeakerScope.test.js \
  test/helpers/transcriptDocument.test.js \
  test/helpers/speakerCorrectionTransaction.test.js \
  test/helpers/transcriptSpeakerState.test.js \
  test/stores/meetingRecordingStoreSpeakerReplay.test.js \
  test/stores/meetingRecordingStoreDiarizationPublish.test.js \
  test/components/noteEditorSummaryDeletion.test.js
```

Result on `73fd1a59a`: **30 tests, 6 passed, 24 failed**. The passing cases include all four human-lock representations and the genuine accepted main-process evaluation. Failure excerpts:

```text
not ok - late accepted final cannot replace an identical row's veto
not ok - main skipped final preserves an identical persisted row veto over cached accepted evidence
not ok - main failed final preserves an identical persisted row veto over cached accepted evidence
not ok - splitting one accepted row partitions its shared cache window and undo keeps sibling evidence
not ok - coordinate-only supersession (track) is refused
not ok - coordinate-only supersession (recording) is refused
not ok - coordinate-only supersession (sample) is refused
not ok - a veto is reevaluated after enrollment, but cached evidence alone leaves it Unknown
not ok - a veto is reevaluated after roster expansion, but cached evidence alone leaves it Unknown
not ok - retroactive cached mapping and reconsideration agree that a durable veto needs a fresh row evaluation
not ok - undo after roster change returns the validated committed rows
not ok - NoteEditor undo after roster change installs committed Unknown safely within its affected rows
not ok - NoteEditor undo after roster change installs stale accepted A safely within its affected rows
not ok - NoteEditor stopped undo revalidates restored automatic decisions against current participants
not ok - restoration cannot bypass a veto outside the action affected rows
```

Naming failures observed `actual: 'A'` versus `expected: undefined`; reconsideration observed zero assignments versus one; undo returned accepted A while persistence held Unknown. The split sibling lost A or moved clusters. Separate baseline completion tests also failed for cached, skipped, and failed completion.

The local raw logs are under `/opt/data/cache/scratch/run5/` (`final-red-baseline.log`, `red-baseline.log`, `red-final-completion-reconsideration.log`). The new tests use the existing public seams and can be copied to another checkout of the baseline to reproduce these failures.

## Verification

- Required eight-file main-process command: **172 passed, 0 failed**.
- `node --import tsx --test --test-reporter=tap test/stores/meetingRecordingStore*.test.js test/components/noteEditor*.test.js`: **146 passed, 0 failed**.
- Additional focused NoteEditor run after the response-scope change: **6 passed, 0 failed**, including a participant edit during the IPC wait. That in-flight test also failed on the baseline. The latest note is read at installation time.
- `node --test test/locales/translationCoverage.test.js`: **9 passed**.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm run build:renderer`: passed, with the existing large-chunk advisory.
- `git diff --check`: passed.

The 21 known `SQLITE_CORRUPT_VTAB` cloud-upsert failures are pre-existing and were left unchanged. The full repository test suite was not rerun; the requested suites above were run.
