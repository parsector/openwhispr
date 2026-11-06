# Fourth fix run: bounded, retryable enrolment recovery

Branch: `fix/enrolment-audio-retention`; starting commit: `49e61cb8d`.

## Fixes and evidence

| Item | Fix and code | Probe output |
| --- | --- | --- |
| P1 startup | Constructor schedules recovery (`src/helpers/meetingAudioStore.js:192`). Queue pages contain at most 25 IDs by default, process one sample at a time and yield for 10 ms between items (`src/helpers/voiceEnrollmentRecovery.js:13`, `:272`). Production recovery uses async decoder processes; synchronous and async codec processes have a 5,000 ms deadline and SIGKILL (`src/helpers/meetingAudioStore.js:58`, `:94`, `:107`, `:642`). Cancellation clears the timer and aborts the active process; application teardown invokes it (`main.js:2290`). | `startup complete: queued=5 clips=0 protected=1`; `bounded completion: recovered=5 passes=3 maxPassItems=2 heartbeats=5` |
| P1 temporary failures | The fourth-run probes covered decoder errors/timeouts, read errors and unavailable-key stubs. Attempts and retry deadlines persisted. Its replacement probe covered only an already-classified recording identity; it did **not** establish rejection after an unclassified first attempt or a content replacement. Its retry handler also demoted resolved provenance on failure. Both gaps are corrected and tested in `fifth-report.md`. Default budget: three failed attempts, with exponential backoff starting at 1 s. Exhaustion becomes `recovery_failed`, with the original cause recorded. The fourth-run probe did not cover errors hidden by chunk existence checks. | `decoder-timeout then success: realProcessTimeout=true attempts=2 recovered=1 bytesEqual=true unrecoverable=0`; `budget exhausted: state=recovery_failed attempts=3 reason=decoder_error restartAttempts=0 retention=expired` |
| P2 corrupt ciphertext | Binary decryption distinguishes unavailable credentials from authentication/truncation failure with a loaded key (`src/helpers/secretCrypto.js:154`). Source spans preserve that cause (`src/helpers/meetingAudioStore.js:708`). Corruption is terminal and releases retention protection; missing keys remain retryable and fail closed. | `corrupt ciphertext + valid key: {"state":"unrecoverable","reason":"audio_corrupt"} deferred=0 retention=expired chunkExists=false`; `missing key: state=pending_recovery attempts=1 deferred=1 retained=complete recognitionProfiles=0`; `key unlocked: persistedBackoff=true recovered=1 deferred=0` |

The timeout recovery probe uses real production FFmpeg encode/decode, with a 1 ms deadline on its first recovery process. Another probe kills a deliberately stalled Node child through the production decoder process adapter: `real stalled child: timeout=30ms signal=SIGKILL; next decode=48000 PCM bytes; all production spawn deadlines=5000ms`.

Coverage correction: the fourth-run key-unlock probe replaced a decrypt stub; it did not exercise `secretCrypto`'s cached keychain fallback. The fifth run exercises that production module through recovery with a locked/unlocked keychain adapter. The transition descriptions below record the fourth run's intended behavior; they were not proof against the retry defects addressed in the fifth run.

## States and transitions

- Queued legacy approvals without a classification are treated as pending for retention immediately, before any page is loaded.
- `pending_recovery` + complete bytes and genuine identity -> durable clip + `resolved`, preserving the original WAV, ID, embedding and approval timestamp. No new review is required. Consent, source identity and current durable ownership are checked again after async decoding, so revocation or replacement during a decode cannot resurrect an old approval.
- Temporary decode/IO/key failure -> `pending_recovery` with incremented `recovery_attempts`, cause and `recovery_next_at`; the scheduled attempt runs after backoff, including across restart.
- Third temporary failure -> `recovery_failed`. No automatic retry on later startups; the stored reason and People status explain that recovery stopped. The user can remove unavailable samples and enrol replacements.
- Missing, expired, deleted, never-recorded or corrupt audio, invalid legacy embeddings, and identity mismatch -> `unrecoverable`.
- Existing durable audio whose genuine recording identity is unknown retains the accepted `pending_recovery` identity behavior. It gets one classification attempt per startup, keeps zero recognition/diversity votes, and needs no source-retention exemption after that attempt. Genuine identity can still resolve on a later startup.
- Cancellation aborts active conversion without recording a failure or saving a clip. A new queue can resume pending work and retains its persisted retry budget/backoff.

## Retention protection

`protects(noteId)` queries approved legacy/durable sources and current provenance, so approvals on later pages and those waiting in backoff are covered (`src/helpers/voiceEnrollmentRecovery.js:70`). Both expiry and eviction consult it (`src/helpers/meetingAudioStore.js:989`); status also keeps protected recordings retained past their old deadline and counts their bytes against the disk budget (`:547`). The durable audio note index keeps the protection lookup local to the note (`src/helpers/voiceExemplarAudio.js:34`).

Protection releases immediately after successful conversion, terminal classification, retry exhaustion, or cancellation. Durable audio with unresolved identity also releases after classification because its clip bytes no longer need the recording. Other pending samples from the same source continue to protect it. One final ordinary sweep reclaims eligible sources after the queue finishes; independent sweeps can reclaim completed sources sooner.

Actual eviction probe: `eviction protection: queuedSources=2 evicted=0; after first classification: protected=1 evictable=1; recovered=2`.

Permanent-key-loss probe: `missing key budget: {"state":"recovery_failed","reason":"audio_key_unavailable","recovery_attempts":3} clips=0 retention=expired`. Cancellation probe: `cancel: decoderAborted=true clips=0; resume: recovered=1`.

## Verification

Commands ran against isolated fixtures, without production data or services:

```sh
npm run lint
node --import tsx --test test/helpers/voiceExemplarAudio.test.js test/helpers/voiceEnrollment.test.js test/helpers/voiceRecordingIdentity.test.js test/helpers/meetingAudioStore.test.js test/helpers/meetingAudioCodecDeadline.test.js test/helpers/secretCryptoBackup.test.js test/helpers/peopleActions.test.js test/helpers/speakerCalibrationExport.test.js test/helpers/retentionSettings.test.js test/helpers/transcriptRetention.test.js
npm run i18n:check
node --import tsx --test test/components/peopleEnrollmentMessages.test.js
npm run typecheck
npm run build:renderer
node --test test/browser/voiceExemplarPlayback.cjs
git diff --check
```

Real output summaries:

```text
lint: eslint . --max-warnings=0 && cd src && eslint . --max-warnings=0 (exit 0)
focused: tests 177; pass 177; fail 0; cancelled 0; skipped 0
[i18n] Locale keys and placeholders are consistent.
translation message tests: tests 11; pass 11; fail 0
typecheck: cd src && tsc --noEmit (exit 0)
build: ✓ built in 8.88s
browser: person row wires mocked exemplar WAV playback and preserves missing-key errors without loading notes
browser: tests 1; pass 1; fail 0; skipped 0
git diff --check: no output (exit 0)
```

189 passing tests total: 177 focused, 11 translation-message tests, one Chromium test. The browser test asserts the recovery-failed explanation and missing-key playback error. Screenshot checks cover 1440/412 widths in light/dark themes. The UI detector returned `[]`.

Artifacts in this directory: `fourth-focused.log`, `fourth-probes.log`, `fourth-lint.log`, `fourth-translations.log`, `fourth-messages.log`, `fourth-types.log`, `fourth-build.log`, `fourth-browser.log`, `fourth-ui-detect.json`, `fourth-{1440,412}-{light,dark}.png`. Changed implementation/test file hunks are in `fourth-diff-ranges.txt` (old/new line ranges).

## Limits

The queue bounds conversion work and decoder lifetime. `repair()` still synchronously reads and decrypts chunks, and retention/accounting sweep the library; healthy-library startup time is not proven identical. SQLite operations and encryption also remain synchronous. This is an isolated startup/queue integration proof, not a wall-clock benchmark of an entire production library. Span requests remain limited to 120 seconds; each decoder child has its own 5 s deadline. Retry exhaustion deliberately requires replacement enrolment rather than an endless retry loop. Existing terminal provenance classifications remain terminal; this migration does not guess whether historical `unrecoverable` records were produced by a temporary error. A loaded but wrong key cannot be distinguished cryptographically from corrupted ciphertext; genuinely unavailable credentials have their own error. The renderer build retains its existing large-chunk warning.

No push, PR, release, deployment or service restart was performed. Skills used: [diagnosing-bugs](/opt/data/home/.codex/skills/diagnosing-bugs/SKILL.md) and [impeccable](/opt/data/home/.codex/skills/impeccable/SKILL.md) for the narrow translated error-copy change.
