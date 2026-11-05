# Fifth fix run: recovery identity and classification integrity

Branch: `fix/enrolment-audio-retention`; starting commit: `dd301676c`. The starting tree was clean. No checkout-local `AGENTS.md` exists; the inherited `/opt/data/dev/AGENTS.md` rules were read before implementation. All probes use isolated fixtures.

**Sixth-run correction:** the fifth-run content pin was unsafe. It identified ciphertext and chunk metadata, not approved audio. Repairing a locked-key orphan index, re-encryption, or re-encoding could reject identical PCM, release retention and delete both source audio and the legacy approval. The historical green output below did not establish PCM identity or safe retention. The sixth run replaces the recovery gate with approved-span PCM SHA-256, retains failures for a fixed seven-day grace period, and preserves unrecovered legacy approval rows after expiry. See [sixth-report.md](sixth-report.md) for current behavior and evidence.

| Defect | Fix and location | Probe |
| --- | --- | --- |
| Unclassified retries could recover replacement bytes | Historical implementation: validate recording identity, persist `recovery_recording_id` and `recovery_content_hash`, then compare ID and disk-byte hash before retry and after decoding. **The content check was incorrect:** SHA-256 covered ciphertext and chunk metadata (`src/helpers/meetingAudioStore.js:591`), so it rejected legitimate storage changes without examining PCM. The sixth run keeps that hash for diagnostics only and verifies the decoded approved span. | ID replacement was refused within one process and across restart. The supposed content replacement probe changed the fake codec's ignored padding, not its decoded audio; refusing it was a false positive. Checking that no second decode occurred therefore established the wrong behavior. The sixth run changes the content probe to mutate PCM inside the approved bounds after a successful decode pins it. Historical output below is retained as a record, not proof of audio identity. |
| Temporary conversion failures demoted resolved provenance | Independently persisted conversion state/reason preserves the resolved recording classification. **The fifth-run release of retention after exhausted conversion was unsafe and is superseded:** the sixth run keeps failed source evidence through a fixed deadline and records unrecoverability on expiry without deleting its approval. | Historically, three decoder failures preserved classification and recording ID but released retention. That deletion behavior is no longer an accepted assertion; the sixth-run regression requires retained source and approval. |
| Existence checks hid temporary filesystem errors | The source chunk existence check now uses `lstatSync` and suppresses only `ENOENT`, preserving file-type validation (`src/helpers/meetingAudioStore.js:15`, `:595`). Non-`ENOENT` errors reach the existing bounded retry path; actual missing source bytes terminate. | Injected `EACCES` and `EBUSY` each produce one retry and then successful recovery. The loss probe unlinks the chunk after construction and exercises native `ENOENT`, terminating after one attempt without protection (`test/helpers/voiceExemplarAudio.test.js:481`). |
| Cached credential fallback poisoned retries | A scheduled key-related retry explicitly refreshes credentials once (`src/helpers/voiceEnrollmentRecovery.js:183`). `refreshAudioKey()` rechecks a cached fallback, with key creation disabled (`src/helpers/secretCrypto.js:50`, `:104`). Ordinary reads continue using their cached backend. Refresh stays within the existing attempt/backoff budget. | Through the real `secretCrypto` module, a locked keychain produces `audio_key_unavailable`, then unlocking allows recovery on retry. Both cached unavailable and safeStorage modes pass, with two keychain reads and zero key writes (`test/helpers/voiceExemplarAudio.test.js:533`). A separate test checks that refresh with a missing entry cannot generate a replacement key (`test/helpers/secretCryptoBackup.test.js:110`). |

The fifth-run additive migration preserved fourth-run classifications, identity pins, retry budgets and deadlines. The sixth-run additive migration also stores PCM identity and provenance, and reopens historical `recording_content_mismatch` refusals once. Decoder deadlines and bounded retries remain; retention release paths have changed as described above.

## Actual regression output

Before the implementation, this command reproduced the reported defects:

```sh
node --import tsx --test --test-name-pattern='fifth run' test/helpers/voiceExemplarAudio.test.js
```

```text
ℹ tests 8
ℹ suites 0
ℹ pass 1
ℹ fail 7
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2200.804095
```

The failures included replacement bytes becoming `resolved`, resolved provenance becoming `recovery_failed`, stat failures being collapsed into missing audio, and unlock yielding zero recovered clips. Native `ENOENT` was already terminal. The final expanded regression command is:

```sh
node --import tsx --test --test-name-pattern='fifth run|credential refresh' test/helpers/voiceExemplarAudio.test.js test/helpers/voiceRecordingIdentity.test.js test/helpers/secretCryptoBackup.test.js
```

Actual diagnostic lines and summary:

```text
ℹ replaced source identity: restart=false state=recovery_failed reason=recording_identity_mismatch decodeAttempts=1 clips=0 pinnedBeforeDecode=true
ℹ replaced source identity: restart=true state=recovery_failed reason=recording_identity_mismatch decodeAttempts=1 clips=0 pinnedBeforeDecode=true
ℹ replaced source content: restart=false state=recovery_failed reason=recording_content_mismatch decodeAttempts=1 clips=0 pinnedBeforeDecode=true
ℹ resolved survives: classification=resolved recordingIdPreserved=true conversion=recovery_failed attempts=3 restartAttempts=0 retention=expired
ℹ source stat EACCES: state=resolved attempted=2 recovered=1 retryReason=EACCES protected=false
ℹ source stat EBUSY: state=resolved attempted=2 recovered=1 retryReason=EBUSY protected=false
ℹ source stat ENOENT: state=unrecoverable attempted=1 recovered=0 retryReason=none protected=false
ℹ keychain unlock: safeStorage=false before=audio_key_unavailable readsBefore=1 readsAfter=2 recovered=1 keyWrites=0
ℹ keychain unlock: safeStorage=true before=audio_key_unavailable readsBefore=1 readsAfter=2 recovered=1 keyWrites=0
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4760.426866
```

## Verification commands and output

```sh
npm run lint
node --import tsx --test test/helpers/voiceExemplarAudio.test.js test/helpers/voiceEnrollment.test.js test/helpers/voiceRecordingIdentity.test.js test/helpers/meetingAudioStore.test.js test/helpers/meetingAudioCodecDeadline.test.js test/helpers/secretCryptoBackup.test.js test/helpers/peopleActions.test.js test/helpers/speakerCalibrationExport.test.js test/helpers/retentionSettings.test.js test/helpers/transcriptRetention.test.js
npm run i18n:check
npm run typecheck
npm run build:renderer
node --test test/browser/voiceExemplarPlayback.cjs
git diff --check
```

Lint (exit 0):

```text
npm notice run open-whispr@1.13.0 lint
npm notice run eslint . --max-warnings=0 && cd src && eslint . --max-warnings=0
```

Focused suites (exit 0):

```text
ℹ tests 188
ℹ suites 0
ℹ pass 188
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 32295.01352
```

After the final file-type preservation adjustment, rechecked the 12 regressions above, plus:

```sh
node --import tsx --test test/helpers/meetingAudioStore.test.js
./node_modules/.bin/eslint src/helpers/meetingAudioStore.js
```

```text
ℹ tests 15
ℹ suites 0
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4043.827867
```

Targeted ESLint produced no output (exit 0). No UI/translation strings changed; translation coverage was checked anyway:

```text
npm notice run open-whispr@1.13.0 i18n:check
npm notice run node scripts/check-i18n.js
[i18n] Locale keys and placeholders are consistent.
```

Typecheck (exit 0):

```text
npm notice run open-whispr@1.13.0 typecheck
npm notice run cd src && tsc --noEmit
```

Renderer build (exit 0), retaining its existing large-chunk warning:

```text
✓ built in 14.42s
```

Browser (exit 0):

```text
✔ person row wires mocked exemplar WAV playback and preserves missing-key errors without loading notes (25340.31957ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 27294.105428
```

`git diff --check`: no output (exit 0). The browser test checks playback and translated failure rendering in Chromium; backend identity/keychain behavior is covered by the isolated IO/SQLite tests above, not by a native desktop/keychain browser simulation.

Raw local outputs are `fifth-{red,probes,focused,lint,translations,types,build,browser,stat-check,stat-lint}.log` in this directory. Generated diff hunks with old/new line ranges for every changed implementation and test file are in [fifth-diff-ranges.txt](fifth-diff-ranges.txt).

## Report corrections and limits

[fourth-report.md](fourth-report.md) now explicitly limits its replacement claim to the already-classified test, identifies the missing unclassified/content cases and resolved-demotion bug, and states that its key-unlock probe replaced a stub rather than exercising cached keychain fallback. Its intended transitions are labeled as such, not as proof against these retry defects.

`repair()` synchronously reads and decrypts chunks, and retention/accounting sweep the library, so healthy-library startup time is **not proven identical**. Diagnostic source hashing also performs synchronous IO. The fifth-run probes established some recording-ID/classification behavior and bounded retries, but **did not establish safe audio content identity**. The sixth-run migration retries prior disk-hash mismatch refusals where approvals remain; neither migration can reconstruct bytes or an approval-time PCM hash that was never saved. A loaded wrong key remains cryptographically indistinguishable from corrupted ciphertext, and the sixth run retains those failures through the explicit grace period.

No push, PR, release, deployment, production-data mutation or service restart was performed. Skill used: [diagnosing-bugs](/opt/data/home/.codex/skills/diagnosing-bugs/SKILL.md). CodeGraph was checked but this worktree has no index, so source/test inspection was used.
