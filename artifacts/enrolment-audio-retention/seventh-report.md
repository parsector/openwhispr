Seventh fix run: exact coverage before decoding or pinning

Branch `fix/enrolment-audio-retention`, starting at `0e5965045` with a clean tree. There is no checkout-local `AGENTS.md`; `/opt/data/dev/AGENTS.md` was read first. The diagnosing-bugs skill was used. This worktree has no CodeGraph index. All recovery, repair, SQLite and AES-GCM operations below use isolated fixtures.

Authenticated intervals must now tile the entire approved span exactly before any decoder input is yielded. New overlaps, duplicate intervals, gaps, authenticated packet/index disagreements and incorrect decoded lengths produce `temporary_failure / source_integrity_failed`. They cannot establish a PCM baseline or save a clip. The historical seven-second baseline is explicitly distrusted and replaced by the next valid 3.5-second decode, with the rejected hash and duration retained as an audit record.

| Responsibility | Location |
| --- | --- |
| Validate integral sample intervals and exact tiling; compare durations with a one-millisecond tolerance | `src/helpers/voiceAudioIntegrity.js:3`, `:32` |
| Reject suspect candidates using index coverage without decoding | `src/helpers/meetingAudioStore.js:628` |
| Check index coverage, authenticate all selected packets and match their headers to the index, then validate authenticated coverage | `src/helpers/meetingAudioStore.js:727`, `:750`, `:762` |
| Shared generator used by synchronous playback and asynchronous recovery | `src/helpers/meetingAudioStore.js:653`, `:666`, `:682` |
| Validate full decoded chunk lengths and assembled approved-span PCM length | `src/helpers/meetingAudioStore.js:781`, `:792` |
| Recovery duration guard before hashing or comparing the baseline | `src/helpers/voiceEnrollmentRecovery.js:355` |
| Guard both pinning and durable clip saving | `src/helpers/voiceRecordingIdentity.js:93`, `src/helpers/voiceExemplarAudio.js:134` |
| Existing approval pin caller, now covered by the duration guard | `src/helpers/voiceEnrollment.js:1040` |
| Persist distrust/correction audit columns | `src/helpers/voiceRecordingIdentity.js:54` |
| Detect suspect legacy baselines before queue selection; replace and record correction after valid decoding | `src/helpers/voiceEnrollmentRecovery.js:35`, `src/helpers/voiceRecordingIdentity.js:108` |
| Compare trusted PCM and record successful repaired-source recovery | `src/helpers/voiceEnrollmentRecovery.js:360`, `:368` |

Coverage has zero sample tolerance. Boundary chunks may extend outside the approved interval: their intersections with that interval must have exactly one owner per sample. All relevant authenticated encoded payloads are collected before the first decode. Startup repair preserves overlapping files for inspection; the read path refuses them rather than silently choosing one. The listing check uses index metadata; playback and recovery repeat the validation using authenticated packet headers.

PCM duration tolerance is one millisecond (24 samples at 24 kHz), including stored duration rounding. Full decoded chunks are checked before trimming, so oversized decoder output cannot be hidden by slicing. Recovery independently checks the assembled WAV's PCM size before hashing. Pinning and saving have their own guards. A duration failure uses `source_integrity_failed`, never `audio_content_mismatch`.

The existing retry function (`voiceEnrollmentRecovery.js:183`) persists attempts and exponential backoff. Defaults remain three attempts with one-second base backoff; exhaustion records `recovery_failed / source_integrity_failed`. Restart does not reset that budget. Source and approval remain protected through the existing fixed seven-day deadline; expiry still records `unrecoverable / evidence_retention_expired` before normal retention can remove the source. Tests use one-millisecond retry backoff for deterministic fast execution.

For legacy approvals without a durable clip, startup compares the baseline's stored duration with `(end_sample-start_sample)/24` milliseconds. A disagreement exceeding one millisecond, missing duration, or noncanonical/missing sample rate makes the pin untrusted. Its hash and duration move to `recovery_untrusted_pcm_hash` and `recovery_untrusted_duration_ms`; active hash/duration/rate are cleared and `recovery_pcm_trust='untrusted'` is persisted. A previous `audio_content_mismatch` refusal caused by that pin is reopened once, including its exhausted attempts. Other exhausted failure budgets and already-unrecoverable classifications are not reopened. The hold deadline and pinned recording, note, track and span identity are preserved.

The next valid exact-coverage decode records a new hash, duration and canonical rate, changes trust to `corrected`, and sets `recovery_pcm_corrected_at`. Subsequent sealing retries retain this new trusted baseline. Successful recovery records `source_repaired` even if only the baseline required correction. Audit values and the correction time survive restart. Durable clips, including healthy resolved evidence, are excluded from baseline correction.

The regression was red before implementation:

```sh
node --import tsx --test --test-name-pattern='seventh run' test/helpers/voiceExemplarAudio.test.js
```

```text
ℹ tests 4
ℹ pass 0
ℹ fail 4
ℹ duration_ms 3501.705328
```

The overlap and duplicate cases had recovered a clip instead of reporting source integrity failure. The historical sequence had `recovered: 0`, `recoveryFailed: 1`; its new distrust assertion failed. The upgrade regression now loads the actual store, recovery and identity implementation at `0e5965045` through [seventh-legacy.cjs](seventh-legacy.cjs) for the first decode/pin/encryption-failure phase, then restarts the current implementation after removing the overlapping chunk. It asserts the historical pin equals the seven-second PCM hash and that the repaired WAV equals the approved WAV. This fast sequence uses the lossless fixture codec; real repair, recovery, encryption and SQLite are exercised throughout. A separate regression uses real FFmpeg decoding and Opus-to-FLAC re-encoding.

Real final output for the six required cases, copied from `seventh-focused-final.log`:

```text
ℹ seventh historical sequence: approved=3.5s first=7s partial=false pinned=true encryption=failed repairedPCMEqual=true trust=corrected reason=source_repaired recovered=1 audio_content_mismatch=false deletions=0
ℹ seventh overlap without encryption failure: reason=source_integrity_failed attempts=3 decoded=0 baseline=null clips=0 deletions=0
ℹ seventh duplicate interval: reason=source_integrity_failed attempts=3 decoded=0 baseline=null clips=0 deletions=0
ℹ seventh pre-existing bad baseline: trustBeforeDecode=untrusted trustAfter=corrected oldHashRetained=true repinned=true reason=source_repaired recovered=1 deadlineUnchanged=true restartUnchanged=true
ℹ sixth different PCM: sameRecording=true pcmEqual=false state=recovery_failed reason=audio_content_mismatch recovered=0 sourceChunks=2 legacyApproval=retained deletions=0
ℹ sixth healthy resolved: durableRowUnchanged=true pcmEqual=true state=resolved source=expired clips=1
```

The different-PCM test also asserts that each source ciphertext file remains byte-identical. The healthy test compares the entire durable row and provenance row before and after restart. Sweep removals and the healthy source's expired manifest are explicitly asserted. Existing re-encryption, orphan repair and rechunking cases still pass with equal approved PCM and `source_repaired`.

Additional actual output:

```text
ℹ seventh duration -0.1s: reason=source_integrity_failed attempts=3 baseline=null clips=0 pinGuard=true saveGuard=true deletions=0
ℹ seventh duration 0.1s: reason=source_integrity_failed attempts=3 baseline=null clips=0 pinGuard=true saveGuard=true deletions=0
ℹ seventh gap: reason=source_integrity_failed attempts=3 decoded=0 baseline=null clips=0
ℹ seventh authenticated index mismatch: reason=source_integrity_failed attempts=3 decoded=0 baseline=null clips=0
ℹ seventh decoded chunk too short: reason=source_integrity_failed attempts=3 decoded=3 baseline=null clips=0
ℹ seventh decoded chunk too long: reason=source_integrity_failed attempts=3 decoded=3 baseline=null clips=0
ℹ sixth failed retention: day4=retained restartDeadlineUnchanged=true day8=expired state=unrecoverable reason=evidence_retention_expired legacyApproval=retained
ℹ sixth real ffmpeg: Opus→Ogg/FLAC chunks=1→2 pcmEqual=true state=resolved reason=source_repaired source=retained
```

Final focused command, exit 0:

```sh
node --import tsx --test test/helpers/voiceExemplarAudio.test.js test/helpers/voiceEnrollment.test.js test/helpers/voiceRecordingIdentity.test.js test/helpers/meetingAudioStore.test.js test/helpers/meetingAudioCodecDeadline.test.js test/helpers/secretCryptoBackup.test.js test/helpers/peopleActions.test.js test/helpers/speakerCalibrationExport.test.js test/helpers/retentionSettings.test.js test/helpers/transcriptRetention.test.js test/components/peopleEnrollmentMessages.test.js
```

```text
ℹ tests 221
ℹ suites 0
ℹ pass 221
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 44419.177262
```

The first broad pass found 19 failures in `voiceEnrollment.test.js`: its mock returned a fixed four-second WAV for trimmed 3.5-second requests. The fixture now returns canonical PCM with the requested duration. The subsequent broad pass passed 221/221, as did the final pass after strengthening the retention assertions.

`npm run lint`, exit 0:

```text
npm notice run open-whispr@1.13.0 lint
npm notice run eslint . --max-warnings=0 && cd src && eslint . --max-warnings=0
```

Stock lint ignores `src/helpers`, so the changed implementation files, helper tests and historical harness were also checked explicitly, exit 0 with no output:

```sh
./node_modules/.bin/eslint --no-ignore --config eslint.config.js src/helpers/voiceAudioIntegrity.js src/helpers/meetingAudioStore.js src/helpers/voiceEnrollmentRecovery.js src/helpers/voiceRecordingIdentity.js src/helpers/voiceExemplarAudio.js test/helpers/voiceExemplarAudio.test.js test/helpers/voiceEnrollment.test.js artifacts/enrolment-audio-retention/seventh-legacy.cjs --max-warnings=0
```

No locale strings changed. `npm run i18n:check` still ran, exit 0:

```text
npm notice run open-whispr@1.13.0 i18n:check
npm notice run node scripts/check-i18n.js
[i18n] Locale keys and placeholders are consistent.
```

`npm run typecheck`, exit 0:

```text
npm notice run open-whispr@1.13.0 typecheck
npm notice run cd src && tsc --noEmit
```

`npm run build:renderer`, exit 0, with the existing warning about chunks exceeding 500 kB:

```text
✓ built in 6.29s
```

`RAYON_NUM_THREADS=2 node --test test/browser/voiceExemplarPlayback.cjs`, exit 0:

```text
✔ person row wires mocked exemplar WAV playback and preserves missing-key errors without loading notes (20200.061894ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 21751.502412
```

`git diff --check`: exit 0, no output. The browser exercises Chromium playback, policy/error disclosure and responsive layouts with mocked IPC. Backend fixtures verify actual storage, repair, consent, PCM and encryption behavior; this is not a native desktop end-to-end test.

Changed ranges are listed below as new-file line envelopes; exact unified diff hunks are available in the commit.

| Changed file | New line ranges |
| --- | --- |
| `src/helpers/voiceAudioIntegrity.js` | New file, 1–47 |
| `src/helpers/meetingAudioStore.js` | 8; 628–638; 726–792 |
| `src/helpers/voiceEnrollmentRecovery.js` | 9; 32–54; 355–358; 368 |
| `src/helpers/voiceRecordingIdentity.js` | 2; 54–57; 93–110; 121 |
| `src/helpers/voiceExemplarAudio.js` | 3; 135–136 |
| `test/helpers/voiceExemplarAudio.test.js` | 211–479; 529–571; 605; 651–653; 663–670 |
| `test/helpers/voiceEnrollment.test.js` | 210–221 |
| `artifacts/enrolment-audio-retention/seventh-legacy.cjs` | New file, 1–23 |
| `artifacts/enrolment-audio-retention/sixth-report.md` | 25; 67–68 |
| `artifacts/enrolment-audio-retention/seventh-report.md` | New report |

[sixth-report.md](sixth-report.md) now corrects the nominal hash-size bound and explicitly identifies previously inferred deletion/expiry diagnostics. Its original output is preserved as historical evidence. Current tests assert those facts directly. Raw local logs are `artifacts/enrolment-audio-retention/seventh-{red,probes,focused,focused-final,lint,explicit-lint,translations,types,build,browser}.log`; logs remain ignored, while this report and the historical harness are committed. Browser screenshots use the existing `fourth-{1440,412}-{light,dark}.png` paths in that directory.

Limits: an approval with no trustworthy historical PCM pin cannot prove what was originally heard. Its next exact-coverage, correct-duration decode establishes the baseline under the pinned recording identity and approved bounds. An invalid historical pin is detectable here through duration/rate metadata; an incorrect pin with a plausible duration remains indistinguishable from a true PCM mismatch. Existing durable clips are not audited or rewritten by this fix. Expired/deleted source bytes cannot be reconstructed, and exhausted non-content retry budgets are unchanged. Lossy re-encoding that changes PCM still fails exact identity. The seven-day hold remains fixed and is enforced on policy/status checks, with explicit owner erasure unchanged. Authenticating all selected packets retains their encoded payloads until decoding completes; this does not establish a whole-library memory/startup bound. The hash function itself remains O(actual PCM bytes), without a standalone size limit; production pin/recovery paths now validate duration first. The historical fixture loader requires Git history containing `0e5965045`.

Final `git status --porcelain`: empty output (clean tree after commit). No push, PR or release.
