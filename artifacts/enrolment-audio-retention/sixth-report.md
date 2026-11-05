# Sixth fix run: approved-span PCM identity and retained failures

Branch `fix/enrolment-audio-retention`, starting at `97a89a768` with a clean tree. There is no checkout-local `AGENTS.md`; `/opt/data/dev/AGENTS.md` was read first. All data probes use isolated fixtures. No production mutation, service restart, push, PR, release or deployment was performed. Skill used: [diagnosing-bugs](/opt/data/home/.codex/skills/diagnosing-bugs/SKILL.md). This worktree has no CodeGraph index.

Recovery now identifies the approved audio, independently of its encrypted representation. A storage change with identical decoded PCM resolves successfully and records `source_repaired`. A real PCM mismatch refuses conversion as `recovery_failed / audio_content_mismatch`, retaining both source and legacy approval.

| Responsibility | Location |
| --- | --- |
| Add PCM hash, track, sample bounds, note identity, codec, rate, duration and fixed expiry; reopen historical disk-hash refusals once | `src/helpers/voiceRecordingIdentity.js:42` |
| Validate canonical mono s16le, 24 kHz WAV; SHA-256 only its PCM data, excluding its 44-byte header | `src/helpers/voiceRecordingIdentity.js:70` |
| Persist immutable approval identity and provenance | `src/helpers/voiceRecordingIdentity.js:88` |
| Pin the audio actually heard at approval, inside the consent/clip transaction | `src/helpers/voiceEnrollment.js:1038` |
| Validate recording ID and note identity; compare pinned approved bounds before decoding | `src/helpers/voiceEnrollmentRecovery.js:228`, `:245`, `:249` |
| Decode the exact approved span, preserving cancellation and asynchronous child deadlines | `src/helpers/voiceEnrollmentRecovery.js:285`; `src/helpers/meetingAudioStore.js:668`, `:684` |
| Compare decoded approved-span PCM; establish a missing historical baseline before clip encryption | `src/helpers/voiceEnrollmentRecovery.js:331`, `:338` |
| Record repaired-source success; disk hash only determines the diagnostic note | `src/helpers/voiceEnrollmentRecovery.js:339`, `:375` |
| Compute diagnostic ciphertext/manifest hash; recognize owned but unindexed chunks | `src/helpers/meetingAudioStore.js:591`, `:600` |
| Probe an entirely unindexed orphan for key-related retry classification | `src/helpers/meetingAudioStore.js:705` |
| Preserve legacy approval rows lacking a recovered durable clip during source cleanup | `src/helpers/voiceEnrollment.js:1516`, `:1565` |

The deadline is seven days from the approval's first enqueue for legacy conversion, including approvals not yet paged (`voiceEnrollmentRecovery.js:18`, `:33`). It is persisted once, never renewed by retries, restart, or index repair. Pending and failed conversions protect their source after the queue finishes or is cancelled. Repaired successful sources remain available for inspection through that same deadline. Protection applies to normal expiry and budget eviction; protected bytes still count toward usage and may prevent new recording writes when the budget is full.

On the first retention/status policy check at or after the deadline, an unfinished conversion becomes `unrecoverable` with `recovery_reason=evidence_retention_expired` **before** the source becomes eligible for ordinary retention (`voiceEnrollmentRecovery.js:91`). The original failure reason is preserved separately. The approval row, consent time, vector, bounds and PCM pin remain. A previously resolved recording classification remains a provenance fact; its independent conversion state becomes failed or unrecoverable, and the existing People counters expose it. Healthy durable clips retain their existing lifetime. Failed samples remain flagged for review in the approved-sample list. Failure disclosure now explains this policy in all eleven locales.

PCM hashing uses the WAV already held for approval or returned by recovery; there is no extra decoder invocation or second PCM copy for hashing. SHA-256 runs synchronously over a `Buffer.subarray`, O(approved span bytes), at most 5,760,000 bytes for a 120-second span. The recovery path passes the computed digest to the pin writer to avoid hashing twice. Diagnostic ciphertext hashing still performs synchronous reads of overlapping source chunks before and after decoding. Startup repair still reads/decrypts chunks synchronously, and policy/accounting still scan the library; this does not establish whole-library startup timing equivalence.

Actual warmed hash-only cost on this host, five warmups and 100 iterations, from `node artifacts/enrolment-audio-retention/sixth-hash-cost.cjs`:

```text
{"seconds":4,"pcmBytes":192000,"iterations":100,"averageMs":0.1471}
{"seconds":120,"pcmBytes":5760000,"iterations":100,"averageMs":4.0658}
```

The reproducible baseline harness loads the four implementation files from the starting commit with `git show`, without changing the checkout. Command:

```sh
node --require ./artifacts/enrolment-audio-retention/sixth-baseline.cjs --test --test-timeout=6000 --test-name-pattern='sixth run: (locked orphan repair|reencrypted|rechunked/reencoded|different PCM|failed evidence|healthy)' test/helpers/voiceExemplarAudio.test.js
```

Actual baseline output (`sixth-baseline-red.log`, exit 1):

```text
✖ sixth run: locked orphan repair (383.911333ms)
✖ sixth run: reencrypted (291.968234ms)
✖ sixth run: rechunked/reencoded (306.283327ms)
✖ sixth run: different PCM (275.5385ms)
✖ sixth run: failed evidence has a fixed expiry and approval survives retention (246.20421ms)
✔ sixth run: healthy resolved evidence is unchanged (202.338404ms)
ℹ tests 6
ℹ pass 1
ℹ fail 5
```

The repaired-source fixtures first advance the source thirty days past capture, then provoke a retry before changing storage. The orphan probe locks decryption, removes a durable chunk from the index, confirms protection, unlocks and restarts the real repair path. The mismatch modifies PCM inside the approved span. The expiry probe checks day four, restarts, verifies the exact same deadline, then sweeps on day eight.

Actual six required diagnostic lines from the passing probes:

```text
ℹ sixth locked orphan repair: sameRecording=true pcmEqual=true state=resolved reason=source_repaired recovered=1 sourceChunks=2 legacyApproval=retained deletions=0
ℹ sixth reencrypted: sameRecording=true pcmEqual=true state=resolved reason=source_repaired recovered=1 sourceChunks=1 legacyApproval=retained deletions=0
ℹ sixth rechunked/reencoded: sameRecording=true pcmEqual=true state=resolved reason=source_repaired recovered=1 sourceChunks=2 legacyApproval=retained deletions=0
ℹ sixth different PCM: sameRecording=true pcmEqual=false state=recovery_failed reason=audio_content_mismatch recovered=0 sourceChunks=2 legacyApproval=retained deletions=0
ℹ sixth failed retention: day4=retained restartDeadlineUnchanged=true day8=expired state=unrecoverable reason=evidence_retention_expired legacyApproval=retained
ℹ sixth healthy resolved: durableRowUnchanged=true pcmEqual=true state=resolved source=expired clips=1
```

Additional probes cover an entirely unindexed locked-key recording, edits outside the approved span, tampered approval bounds, missing legacy vectors, persisted migration pins/deadlines, and real FFmpeg decoding after Opus→Ogg/FLAC re-encoding and rechunking. Actual native codec output:

```text
ℹ sixth real ffmpeg: Opus→Ogg/FLAC chunks=1→2 pcmEqual=true state=resolved reason=source_repaired source=retained
```

The first green focused pass ran 207 tests. Two more span-identity regressions and a migration regression were then checked in a 210-test pass. Final verification output follows below.

Final focused command (exit 0), including the missing-vector regression:

```sh
node --import tsx --test test/helpers/voiceExemplarAudio.test.js test/helpers/voiceEnrollment.test.js test/helpers/voiceRecordingIdentity.test.js test/helpers/meetingAudioStore.test.js test/helpers/meetingAudioCodecDeadline.test.js test/helpers/secretCryptoBackup.test.js test/helpers/peopleActions.test.js test/helpers/speakerCalibrationExport.test.js test/helpers/retentionSettings.test.js test/helpers/transcriptRetention.test.js test/components/peopleEnrollmentMessages.test.js
```

```text
ℹ tests 211
ℹ suites 0
ℹ pass 211
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 37605.098808
```

`npm run lint` (exit 0):

```text
npm notice run open-whispr@1.13.0 lint
npm notice run eslint . --max-warnings=0 && cd src && eslint . --max-warnings=0
```

After the final missing-vector and recovered recording-ID changes, reran the full focused command above. Both stock ESLint configurations ignore `src/helpers`, so direct lint attempts initially produced an ignored-file warning. Explicitly linted every changed implementation and helper test with the main-process configuration and ignore rules disabled (exit 0, no output):

```sh
./node_modules/.bin/eslint --no-ignore --config eslint.config.js src/helpers/meetingAudioStore.js src/helpers/voiceEnrollment.js src/helpers/voiceEnrollmentRecovery.js src/helpers/voiceRecordingIdentity.js test/helpers/voiceExemplarAudio.test.js test/helpers/voiceEnrollment.test.js test/helpers/voiceRecordingIdentity.test.js --max-warnings=0
```

`git diff --check`: exit 0, no output.

`npm run i18n:check` (exit 0):

```text
npm notice run open-whispr@1.13.0 i18n:check
npm notice run node scripts/check-i18n.js
[i18n] Locale keys and placeholders are consistent.
```

`npm run typecheck` (exit 0):

```text
npm notice run open-whispr@1.13.0 typecheck
npm notice run cd src && tsc --noEmit
```

`npm run build:renderer` (exit 0, existing large-chunk warning):

```text
✓ built in 18.69s
```

The initial `node --test test/browser/voiceExemplarPlayback.cjs` crashed while concurrent checks were creating native thread pools:

```text
The global thread pool has not been initialized.: ThreadPoolBuildError { kind: IOError(Os { code: 11, kind: WouldBlock, message: "Resource temporarily unavailable" }) }
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

The rerun, `RAYON_NUM_THREADS=2 node --test test/browser/voiceExemplarPlayback.cjs`, passed (exit 0):

```text
✔ person row wires mocked exemplar WAV playback and preserves missing-key errors without loading notes (17804.865438ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 20363.231726
```

The browser checks Chromium playback, missing-key errors, failure/expiry policy disclosure and responsive layouts. Native keychain, SQLite, source repair and PCM identity are exercised by backend fixtures, not simulated desktop integration in the browser.

Limits: an old approval with no saved PCM hash cannot prove what the owner originally heard. Its first complete decode establishes the baseline; recording identity and span bounds are pinned before that decode. The unclassified retry probe now successfully decodes the original PCM before inducing a sealing failure, then verifies that a different decoded span is refused. No ciphertext hash can fill the historical proof gap. Bytes and approval rows already deleted by earlier versions cannot be reconstructed. A lossy re-encode that changes even one decoded sample correctly fails the exact-PCM rule; the native re-encode probe uses FLAC to preserve PCM. Conversion remains bounded by existing attempt/backoff limits and five-second decoder deadlines; failure does not grant another automatic retry budget on every restart. The seven-day hold expires on a policy sweep/status check, not while the app is closed, and does not override an explicit owner erase action or an explicit keep-recording setting.

[fifth-report.md](fifth-report.md) now explicitly retracts its content-safety and safe-release claims and identifies its ignored-padding probe. Generated old/new diff ranges are in [sixth-diff-ranges.txt](sixth-diff-ranges.txt). Local raw outputs are `sixth-{baseline-red,probes,focused,focused-final,focused-complete,lint,lint-final,explicit-lint,translations,types,build,browser,browser-retry,hash-cost}.log` in this directory; generated logs remain local. Reusable baseline and hashing harnesses are committed alongside this report.
