# Calibration bounded-evidence fix report

The clean `master` checkout supplied to this task began at `8b67ac2b502babb743247c7167bf26ebd1e3e095`, rather than the stated `cab180acf`. Its affected calibration product files matched `cab180acf`. Existing history was preserved. A separate detached checkout of exactly `cab180acf` was used to execute the new regressions against the release under review.

## Root causes and corrections

Locations in this paragraph refer to `cab180acf`.

1. `src/helpers/meetingAudioSpan.mjs:97` fell back to completion minus ten seconds without exposing why the interval was chosen; `src/helpers/speakerInAppCalibration.js:525` then selected the last eight seconds. The exclusion branches at line 502 did not clear stored centroids, and line 573 passed every row with a vector to the report, including excluded rows. Calibration now gates on timing provenance before audio extraction and again before sweep/admission construction, so a stored vector cannot reintroduce an excluded row. It reads the bounded interval rather than an eight-second tail. Both capture bounds suffice even without a completion timestamp.
2. `src/helpers/speakerInAppCalibration.js:534` hashed concatenated reconstructed WAV windows per note, then assigned that aggregate to every row at line 564. Line 123 overwrote evidence hashes under `noteId`; `src/helpers/speakerCalibrationPolicy.js:98` required every row to equal that note value. Hashes now belong to individual candidates, identified by note, exemplar ID (if any), row ID, track and interval. Each reconstructed WAV gets its own SHA-256. Saved exemplar hashes remain hashes of complete saved WAV bytes. Admission compares each row's expected hash to its verified hash and rejects missing, malformed, unverified or mismatched evidence with a named integrity cause. Save/reload validation understands the new row format and preserves the legacy format for previously applied settings.
3. `src/helpers/speakerInAppCalibration.js:572` never supplied independent production validation, while `src/components/settings/SpeakerCalibrationReport.tsx:25` displayed every failed criterion in one list. The report now explains the version limitation first, separates unavailable evaluation capabilities from measured evidence limits, and makes the diagnostic sweep secondary. Diagnostic reports no longer suggest collecting more labels or approvals as a way to unlock recommendations. Supported recommendation rendering and manual saving remain covered by unchanged assertions.

No admission target, policy number, scoring formula, threshold candidate, profile construction, enrollment rule or retention rule changed. No version, release tag or changelog change was made.

## Timing provenance

These machine-readable values are carried from the shared resolver through export, collection and the report. Counts cover considered candidates, including excluded candidates.

| Value                           | Meaning                                                        | Scoring eligibility                                              |
| ------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `exact_stored_span`             | Stored sample coordinates for the matching recording and track | Only when retained playback contains the whole labelled interval |
| `capture_bounds`                | Both speech start and speech end were stored                   | Only when retained playback contains the whole labelled interval |
| `onset_only`                    | Speech start, with no capture end                              | Excluded as `window_onset_only`                                  |
| `completion_timestamp_fallback` | Completion timestamp used to guess the window                  | Excluded as `window_completion_timestamp_fallback`               |
| `unavailable`                   | Timing or recording identity cannot establish a window         | Excluded as `window_unavailable`                                 |
| `retained_exemplar_clip`        | A previously approved, retained bounded clip                   | Uses the saved vector and verifies complete clip bytes           |

A clipped interval is excluded as `window_label_not_contained`; playback/range/audio failures retain their specific reasons. Exclusions apply before calibration examples, right/wrong/refused totals, machine-claim admission counts, and other tuning admission counts are calculated. Independent evaluation is not manufactured from historical rows: this job continues to supply no evaluation observations or positives/negatives.

## Executed red/green evidence

For each defect, its primary regression was added and run before its product fix. The completion-only regression failed with `1 !== 0` scored examples; both same-note valid-fingerprint regressions failed with `true !== false` for the fingerprint failure; the report regressions failed on the old headline and missing developer disclosure. The final eight regressions were also executed in the detached `cab180acf` checkout: **8 tests, 0 passed, 8 failed**. The failures included one shared hash instead of two row hashes (`1 !== 2`) and a clipped capture interval still scored (`1 !== 0`).

The same selection on the fixed tree: **8 tests, 8 passed, 0 failed**.

```sh
node --import tsx --test --test-name-pattern='unbounded historical|different verified|missing, invalid, unverified|diagnostic report leads|too few scored|capture bounds clipped|reconstructed fingerprints verify' test/helpers/speakerInAppCalibration.test.js test/helpers/speakerCalibrationAdmission.test.js test/components/speakerCalibrationReport.test.js
```

No existing assertion was deleted or changed. Direct report fixtures now explicitly provide their bounded timing and verified hashes. An existing outside-range assertion caught an exclusion-reason ordering regression during development; the product code was fixed to preserve that assertion.

## Required verification

```sh
node --import tsx --test test/helpers/calibrationLiveness.test.js test/helpers/calibrationSpanContext.test.js test/helpers/calibrationEvidenceIndex.test.js test/helpers/speakerCalibration.test.js test/helpers/speakerInAppCalibration.test.js test/helpers/speakerCalibrationAdmission.test.js test/helpers/speakerCompletionDiagnostic.test.js test/helpers/speakerThresholdApplication.test.js test/helpers/meetingSpeakerReconcile.test.js test/components/speakerCalibrationReport.test.js test/helpers/meetingAudioStore.test.js test/helpers/voiceEnrollment.test.js
node --test test/locales/translationCoverage.test.js
npm run lint
npm run typecheck
npm run build:renderer
```

| Command                           | Result                                                    |
| --------------------------------- | --------------------------------------------------------- |
| Requested helper/component suites | 164 tests, 164 passed, 0 failed, 0 skipped/cancelled/todo |
| Translation coverage              | 9 tests, 9 passed, 0 failed, 0 skipped/cancelled/todo     |
| Lint                              | Exit 0; 0 errors, 0 warnings                              |
| Typecheck                         | Exit 0; 0 TypeScript diagnostics                          |
| Renderer build                    | Exit 0; build completed (existing chunk-size advisory)    |

The component was rendered through the existing SSR test harness in diagnostic, insufficient-example and supported states. The UI detector returned `[]`. All eleven locales contain the new copy with matching interpolation variables.

The suite output also includes legacy-recovery teardown logs about closed test databases and Node module-type warnings; these did not fail tests or checks.

## What the owner's next run shows

The headline is **“Calibration recommendation unavailable in this version.”** The next sentence explains that historical reconstruction does not perform the independent production evaluation required for a recommendation. The unavailable capabilities are listed under **“Not available in this version”**, using neutral capability names rather than blaming the library. Recorded claims below ten, unusable windows and any actual integrity failures appear under **“Limits of the available evidence”**.

The report shows the actual scored-example count after exclusions, counts and reasons for exclusions, a timing-provenance breakdown, scored-evidence machine claims against the unchanged minimum, and saved exemplars versus scored exemplar/reconstructed rows. Unusable rows are counted without becoming refusals. Valid different clips/windows within one note cease to cause fingerprint failures. Actual integrity failures identify their cause without asking the owner to replace approvals.

The threshold table is in a closed **“Developer diagnostics: Diagnostic threshold sweep”** disclosure. Below the existing twelve-example minimum, the table is absent and the report states the scored count and required minimum. Supported recommendations retain their existing recommendation and apply controls. Manual settings keep working.

The owner's private library was not available in this workspace. No corrected library counts are claimed here: in particular, “approximate” alone does not distinguish usable capture bounds from an unusable fallback. The new run will establish those counts, and a much smaller scored set is an expected, visible result.

## Exact added or revised English report copy

The following strings are shipped through the existing translation mechanism in all eleven locales. Templates retain their interpolation variables.

- `calibrationAdmission.audio_fingerprints`: Fingerprint integrity check failed for included evidence.
- `calibrationUnavailable`: Calibration recommendation unavailable in this version.
- `calibrationVersionLimit`: The analysis reconstructs historical audio and does not perform the independent production evaluation a recommendation requires.
- `calibrationUnavailableGroup`: Not available in this version
- `calibrationEvidenceGroup`: Limits of the available evidence
- `calibrationManualAvailable`: You can continue to use manual settings.
- `calibrationScoredSummary`: Scored examples after exclusions: {{rows}}.
- `calibrationClaimsSummary`: Recorded machine claims among scored evidence: {{machineClaims}}; minimum required: {{minimum}}.
- `calibrationSourceSummary`: Saved exemplars: {{savedExemplars}}; scored exemplars: {{exemplarRows}}; scored reconstructed rows: {{reconstructedRows}}.
- `calibrationTimingTitle`: Timing provenance
- `calibrationIntegrityTitle`: Fingerprint integrity check
- `calibrationIntegrityItem`: Note {{noteId}}, row {{rowId}}: {{reason}}.
- `calibrationDeveloperSweep`: Developer diagnostics: Diagnostic threshold sweep
- `calibrationSweepUnavailable`: Threshold sweep unavailable: {{rows}} scored examples; at least {{minimum}} are required.
- `calibrationProcessingSummary`: Playback placement — exact: {{exact}}, approximate: {{approximate}}, unavailable: {{unavailable}}. Re-embedded rows: {{embedded}}; excluded rows: {{excluded}}.
- `calibrationTiming.exact_stored_span`: Exact stored span
- `calibrationTiming.capture_bounds`: Capture start and end bounds
- `calibrationTiming.onset_only`: Onset only
- `calibrationTiming.completion_timestamp_fallback`: Completion-timestamp fallback
- `calibrationTiming.unavailable`: Timing unavailable
- `calibrationTiming.retained_exemplar_clip`: Retained exemplar clip
- `calibrationTiming.label_not_contained`: Labelled interval not fully contained in retained window
- `calibrationIntegrity.missing_fingerprint`: fingerprint missing for this evidence item
- `calibrationIntegrity.invalid_fingerprint`: fingerprint invalid for this evidence item
- `calibrationIntegrity.unverified_fingerprint`: no verified audio hash for this evidence item
- `calibrationIntegrity.fingerprint_mismatch`: verified audio hash does not match this evidence item
- `calibrationIntegrity.exemplar_integrity_failed`: saved clip bytes failed length or fingerprint verification
- `calibrationUnavailableCriteria.production_parity`: Production-parity evaluation
- `calibrationUnavailableCriteria.independent_sessions`: Independent recording sessions for evaluation
- `calibrationUnavailableCriteria.positive_coverage`: Evaluation coverage of enrolled people
- `calibrationUnavailableCriteria.negative_coverage`: Evaluation coverage of unenrolled or unknown people
- `calibrationUnavailableCriteria.nonempty_accepted_set`: Accepted names in independent evaluation
- `calibrationUnavailableCriteria.correct_name_coverage`: Evaluation correct-name coverage
- `calibrationUnavailableCriteria.precision`: Evaluation precision
