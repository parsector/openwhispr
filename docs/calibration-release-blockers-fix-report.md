Fix run against `aac31d4dd2cfa5e2d06568fb2c8f7cad3d7ddacf`, on `master`.
Verification host: Linux arm64, Node v26.7.0, installed Electron 43.8.3.

The first root cause was `src/helpers/calibrationAudioSession.js:60-63` at
the review base: the cache published a spill filename before writing it, and
a write exception skipped both the byte decrement and PCM eviction. The
row-level decoder catch turned the failure into missing evidence while the
cache retained the oversized entry. The fix is at
[calibrationAudioSession.js:68](../src/helpers/calibrationAudioSession.js#L68).

Chosen behavior: preserve the memory bound and continue. A failed spill discards
the entry, decrements decoded bytes, attempts to remove the partial encrypted
file, and disables further spills for that session. Subsequent eviction is
memory-only; later rows re-decode their source if needed. This preserves evidence
when storage fills, at the cost of additional decoding. The default PCM cache
budget remains 32 MiB. Closing a session also zeros its counters.

The second root cause was `src/workers/calibrationWorker.js:40-52` together with
`src/helpers/secretCrypto.js:210` at the review base: the warm path copied an
already-cached key, but the cold path only tried Keychain and omitted the existing
safeStorage backup. The fix is at
[calibrationWorker.js:52](../src/workers/calibrationWorker.js#L52),
[secretCrypto.js:115](../src/helpers/secretCrypto.js#L115), and
[calibrationWorkerClient.js:93](../src/helpers/calibrationWorkerClient.js#L93).

The worker still reads the existing Keychain credential off the main thread. If
it cannot obtain a valid key, it requests an existing-key-only broker on main.
Main checks for an already-cached key, otherwise asynchronously reads only
`secure-keys/master-key-backup.enc` and decrypts it through safeStorage's async
API. Missing, locked, invalid or unreadable backup leaves the key unavailable
and preserves `exemplar_key_unavailable`. This path never invokes key
initialization, generates a recording key, writes a Keychain entry, rewrites the
backup, or caches the recovered key on main. The audio envelope and decrypted
audio file set are unchanged. Temporary mutable key copies are erased, including
late results after cancellation or timeout; the dedicated IPC buffer is
transferred and the worker erases it after taking its key copy.

Electron documents the async API as non-blocking and able to decrypt data written
by the synchronous API:
[safeStorage documentation](https://www.electronjs.org/docs/latest/api/safe-storage).
The implementation uses APIs present in the installed Electron types. Native
platform behavior remains subject to the limitations below.

Worker liveness handling also now rejects message-deserialization errors and
failed replies, catches asynchronous reply rejections, and marks setup-storage
errors failed. A pending broker has its own 60-second deadline, so ongoing
heartbeat messages cannot hide a stalled credential recovery. That deadline
fails with `Calibration key recovery timed out; restart calibration`. Failure
regressions assert a failed state with no report. The existing 60-second
silent-worker deadline, 8-second audio embedding slice, 10,000-row admission
budget and cancellation behavior remain unchanged. No policy, scoring,
threshold, admission or evidence-selection changes were made.

All six added regressions were run against an isolated detached worktree at the
unchanged base. Only the additional tests and their test-only worker bootstrap
were installed in that worktree; product sources remained at `aac31d4dd`.
The existing test assertions were untouched. The command in both worktrees was:

```sh
node --import tsx --test --test-name-pattern='worker .*failure|pending key broker|mid-run ENOSPC|cold backup-only' test/helpers/calibrationLiveness.test.js
```

| New regression | Base failure observed | Fixed result |
| --- | --- | --- |
| Mid-run partial spill plus ENOSPC | 307 reconstructed rows instead of 340; 33 `audio_temporary_failure` exclusions | Complete report matches reference evidence, all 340 rows; every sampled PCM counter within the injected 32-byte budget; counter zero after close; no unhandled rejection |
| Cold backup-only approved audio | 0 eligible approved exemplars instead of 1 | 1 eligible exemplar with backup, 0 without backup and the existing reason code; no source chunks, cached key, key writes, backup overwrite or library mutation |
| Worker message deserialization | Ignored error; test fallback eventually rejected instead | Immediate visible failure |
| Worker reply delivery | Reply callback escaped as an unhandled rejection | Visible failed state, no unhandled rejection |
| Worker setup storage | Rejection left state `running` | State `failed` with `EEXIST` |
| Pending key recovery | Missing expected rejection: old worker completed without recovering evidence | Visible deadline failure, prompt cancellation, late keys erased |

Actual runner summaries:

```text
Base:   tests 6, pass 0, fail 6, cancelled 0, skipped 0, todo 0; exit 1
Fixed:  tests 6, pass 6, fail 0, cancelled 0, skipped 0, todo 0; exit 0
```

The ENOSPC regression exercises the real session and local calibration engine
with an injected spill write failure after a successful spill. It compares the
entire report except per-run ID/timestamp and physical bytes read, which change
with cache reuse. No evidence fields or assertions are relaxed. The cold-start
test uses a real worker, real SQLite snapshot, real durable approved ciphertext,
and real audio authentication/content validation. Its safeStorage backend is a
faithful asynchronous API stub backed by authenticated encryption, with a
delayed decrypt and a main-thread heartbeat; synchronous access throws. The
Keychain stub returns no entry. Codec and embedding inference use the existing
deterministic fixture stubs. The deadline test accelerates only the worker's
60,000-ms key-wait timer to 30 ms; it does not wait a physical minute.

The exact required verification commands were run:

```sh
node --import tsx --test test/helpers/calibrationLiveness.test.js test/helpers/calibrationSpanContext.test.js test/helpers/calibrationEvidenceIndex.test.js test/helpers/speakerCalibration.test.js test/helpers/speakerInAppCalibration.test.js test/helpers/speakerCalibrationAdmission.test.js test/helpers/meetingAudioStore.test.js test/helpers/meetingAudioTimeline.test.js test/helpers/meetingAudioCodecDeadline.test.js test/helpers/voiceExemplarAudio.test.js test/helpers/secretCryptoBackup.test.js test/helpers/voiceEnrollment.test.js
npm run lint
npm run typecheck
npm run build:renderer
```

| Command | Final result |
| --- | --- |
| Required Node test command | 215 passed, 0 failed; 0 cancelled/skipped/todo; exit 0 |
| `npm run lint` | 1 successful command, 0 failed; 0 errors, 0 warnings; exit 0 |
| `npm run typecheck` | 1 successful command, 0 failed; 0 diagnostics; exit 0 |
| `npm run build:renderer` | 1 successful command, 0 failed; 2,097 modules transformed; exit 0 |

The first lint attempt failed with three unused-binding warnings in the new
report-normalization helper. Those bindings were renamed with underscore
prefixes, without changing any assertions, and the required lint command was
rerun successfully. Renderer build emitted the chunk-size warning for chunks
larger than 500 kB. The liveness fixture completed off-thread with a measured
14.5-ms maximum main-thread CPU slice during the required suite run.

Raw local artifacts (ignored, under `node_modules/.cache/`):

- `calibration-baseline-regressions.log`: six observed baseline failures.
- `calibration-fix-regressions.log`: six fixed regression passes.
- `calibration-fix-tests.log`: full required suite and 215/0 summary.
- `calibration-fix-lint.log`: initial lint failure.
- `calibration-fix-lint-final.log`: successful final lint.
- `calibration-fix-typecheck.log`: successful typecheck.
- `calibration-fix-renderer.log`: successful renderer build and warning.

Remaining unverified platform assumptions:

- Real macOS safeStorage decryption of an existing synchronous-format backup
  through `decryptStringAsync`, including locked/login Keychain, user prompts,
  refusal and temporary-unavailability behavior. No real safeStorage or macOS
  Keychain was used by the new regression.
- Native `@napi-rs/keyring` credential reads and Electron async credential
  acquisition under actual macOS window/UI load; the automated heartbeat checks
  use stubs and a Node main thread.
- The signed/packaged macOS app's ASAR loading, native dependency loading,
  entitlement and Keychain identity behavior. Packaging was accepted in the
  review basis and was not rebuilt or requalified in this fix run.
- Real Windows DPAPI and Linux desktop secret-store async recovery, including
  their compatibility with existing backups, were not exercised.
- The deadline regression accelerates time; native credential operations that
  remain pending after cancellation cannot be forcibly cancelled by the async
  safeStorage API. The job stops waiting and any eventual mutable key result is
  erased. JavaScript strings and native-internal copies cannot be explicitly
  zeroed; no additional persistent key cache was introduced.

No version bump, tag, release, push, production-data mutation or policy retuning
was performed.

Changed source/test ranges in the fixed tree:

| File | Changed lines |
| --- | --- |
| `src/helpers/calibrationAudioSession.js` | 20, 23-30, 68-86, 139 |
| `src/helpers/calibrationWorkerClient.js` | 18-52, 63-74, 82, 93-109, 117-123, 149 |
| `src/helpers/secretCrypto.js` | 111-129, 230 |
| `src/workers/calibrationWorker.js` | 21, 27-37, 52-55, 67-80, 132-133, 197 |
| `test/helpers/calibrationLiveness.test.js` | 120-424 (additions only) |
| `test/lib/calibrationKeyWorker.js` | 1-25 (new test fixture) |
| `docs/calibration-release-blockers-fix-report.md` | New verification report |
