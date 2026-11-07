# Calibration bounded-evidence follow-up

Baseline: `master` at `212c8dc6f5ee10a1692389379ebde066a05dc8ed`.
Commit subject: `fix(calibration): score only bounded vectors, exclude conflicts before admission, and align export and freshness`.

The six fixes preserve the 0.90 precision, 0.70 correct-name coverage, 10-claim and 12-example admission targets. Candidate thresholds, scoring formulas, enrollment and retention are unchanged. No version bump, tag, release, push or CHANGELOG edit was made.

## Root causes and repairs

Line numbers in the root-cause column refer to the baseline; repair references refer to this commit.

| Gap | Root cause at baseline | Repair | Observed failure before / result after |
| --- | --- | --- | --- |
| 1 | `src/helpers/speakerInAppCalibration.js:619` replaced a centroid only when the vector was missing. `src/helpers/speakerEmbeddings.js:149` did not limit that centroid's membership to admitted intervals. | `src/helpers/speakerInAppCalibration.js:631` always replaces the historical vector with the bounded reconstruction; null, failed or nonfinite extraction excludes the row. The report builder rejects explicit stored-centroid evidence without verified source intervals at line 135. | Contradictory centroid: winner had **0 right**, expected 1. After: **1 right, 0 wrong, 1 reconstructed row**. Explicit centroid-only evidence: **40 admitted → 0**, with 40 named exclusions. Extraction exceptions now produce an exclusion. |
| 2 | `src/helpers/speakerInAppCalibration.js:152` removed conflicts from the cluster sweep while retaining their rows in admission and evidence bindings. | `src/helpers/speakerInAppCalibration.js:147` expands the conflict to each member, then removes members before deriving admitted counts, hashes, revisions and claims. | The ten-claim conflict fixture returned **supported_recommendation**. After: **diagnostic_only**, zero admitted claims, 30 admitted rows, 10 explicit conflict exclusions and 30 hash bindings. |
| 3 | `src/helpers/speakerCalibrationExport.js:90` exposed fallback coordinates without calibration eligibility; `scripts/calibrate.js:78` accepted finite coordinates and line 58 independently selected a tail window. | Shared `src/helpers/calibrationEvidenceWindow.js:3`; export annotates eligibility at `src/helpers/speakerCalibrationExport.js:115`; CLI filters before measurement, overlap, cohorts and sweep at `scripts/calibrate.js:71`, and uses the full bounded interval at line 59. All-unusable CLI input names and counts exclusions in its error before measuring audio. | Export exclusion was **undefined**. CLI scored **5 rows**, including the fallback. After: named `window_completion_timestamp_fallback` exclusion and **4 scored rows**. |
| 4 | `src/helpers/speakerInAppCalibration.js:674` never checked the row hash map or reconstructed bytes; lines 491/312 kept dependencies from excluded evidence and line 696 checked them. | Shared schema/binding validation at `src/helpers/speakerCalibrationPolicy.js:79`, used by freshness, apply and reload. Revisions retain interval identity. Freshness re-reads included WAV bytes at `src/helpers/speakerInAppCalibration.js:761`; no note-centroid dependencies are retained at line 342. | Empty hash map and changed audio bytes each returned **true** for freshness; unused or fully excluded note centroid changes returned **false**; a rebound persisted row retained **calibrated** status. After: each verdict reverses correctly. |
| 5 | `src/helpers/speakerInAppCalibration.js:119` keyed exclusions by note and first row ID, conflating different clips. | `src/helpers/speakerInAppCalibration.js:16` carries the complete fingerprint key, including exemplar ID, through every job exclusion. The builder expands row-wide and cluster-wide exclusions into explicit evidence records. Integrity diagnostics and their UI keys also retain the evidence key. | Both a report fixture and the real SQLite/audio job had **0 scored exemplars** when just one of two sibling clips failed. After: **2 saved, 1 scored, 1 excluded**; the retained clip also passes freshness. |
| 6 | `src/helpers/speakerCalibrationPolicy.js:125` treated zero rows as failed fingerprint integrity, selecting `src/locales/en/translation.json:6075`'s corruption copy. | `src/helpers/speakerCalibrationPolicy.js:174` separates `audio_evidence` availability from fingerprint integrity. All eleven locales have a dedicated availability message. | Empty rendering contained **“Fingerprint integrity check failed for included evidence.”** and lacked the absence message. After: absence copy is shown, no integrity failure is alleged, and recommendation remains unavailable. |

New English copy: **“No included audio evidence is available for calibration.”**

Translated equivalents were added under `people.calibrationAdmission.audio_evidence` in ar, de, en, es, fr, it, ja, pt, ru, zh-CN and zh-TW.

## Fail-then-pass evidence

All new regression tests were copied unchanged into a detached worktree at the exact baseline and executed against its product code. The following command was run in that baseline worktree and then the working tree:

```sh
node --import tsx --test --test-name-pattern='gap [1-6]' test/helpers/calibrationBoundedGaps.test.js test/helpers/speakerCalibrationExport.test.js test/scripts/calibrate.test.js test/components/speakerCalibrationReport.test.js
```

Baseline output, exit 1:

```text
ℹ tests 15
ℹ pass 0
ℹ fail 15
```

Fixed output, exit 0:

```text
ℹ tests 15
ℹ pass 15
ℹ fail 0
```

The failures included the actual wrong winner, supported conflict admission, scored fallback row, ignored hash-map deletion, unchanged-manifest audio mutation, unused dependency invalidation, rebound persisted identity, sibling-clip collision and misleading rendered copy. Full output is retained locally in `node_modules/.cache/calibration-run2-baseline.log` and `node_modules/.cache/calibration-run2-regressions.log`.

## Requested verification

Exact requested module command:

```sh
node --import tsx --test test/helpers/calibrationLiveness.test.js test/helpers/calibrationSpanContext.test.js test/helpers/calibrationEvidenceIndex.test.js test/helpers/speakerCalibration.test.js test/helpers/speakerInAppCalibration.test.js test/helpers/speakerCalibrationAdmission.test.js test/helpers/speakerCompletionDiagnostic.test.js test/helpers/speakerThresholdApplication.test.js test/helpers/meetingSpeakerReconcile.test.js test/components/speakerCalibrationReport.test.js test/helpers/meetingAudioStore.test.js test/helpers/voiceEnrollment.test.js test/helpers/speakerCalibrationExport.test.js
```

Actual output, exit 1:

```text
ℹ tests 166
ℹ pass 165
ℹ fail 1
✖ background job counts retained bytes and re-embedded reviewed rows
+ 'reconstructed-row-audio'
- 'stored-centroid-current-profiles'
```

The unchanged assertion at `test/helpers/speakerInAppCalibration.test.js:330` explicitly requires centroid scoring after successful reconstruction. The same existing test also expects deleting an unused centroid to invalidate freshness at line 333. Both expectations encode the reported defects. Existing assertions were left unchanged as instructed; product behavior and the new regressions enforce bounded evidence. The full requested module command therefore remains red for this one obsolete test. Its complete output is in `node_modules/.cache/calibration-run2-tests.log`.

The export and CLI test files did not exist at baseline. The closest existing coverage, `test/helpers/speakerCalibration.test.js`, was run in the module command above; new dedicated suites were also added at the requested paths.

Other exact commands:

```sh
node --test test/locales/translationCoverage.test.js
node --import tsx --test test/scripts/calibrate.test.js
npm run lint
npm run typecheck
npm run build:renderer
```

Results: locale coverage **9 passed / 0 failed**; CLI **1 passed / 0 failed**; lint, typecheck and renderer build **exit 0**. The renderer build emitted its bundle-size warning. Local logs: `node_modules/.cache/calibration-run2-locales.log`, `calibration-run2-cli.log`, `calibration-run2-lint.log`, `calibration-run2-typecheck.log`, and `calibration-run2-build.log` in the same directory.

## Owner-visible behavior and changed files

Historical audio appears as reconstructed evidence, and its scores reflect the bounded audio. Per-row reconstruction can increase the number of scored examples compared with the old one-per-centroid sweep. Conflicts remove their member rows and claims from all admitted totals. One failed clip leaves sibling clips eligible. Missing evidence gets absence copy; genuine hash problems retain their integrity diagnostics. Included byte changes invalidate freshness, while unused/excluded centroid changes do not. Older reports lacking the row-evidence schema must be regenerated before application.

Product changes are in `src/helpers/speakerInAppCalibration.js`, the new `calibrationEvidenceWindow.js`, `speakerCalibrationPolicy.js`, `speakerCalibrationExport.js`, `speakerCalibrationAction.js`, `speakerDecisionThresholds.js`, `scripts/calibrate.js`, and the synthetic CLI fixture's timing metadata. UI changes are the complete integrity-item key and its type, plus one message in each locale. Regressions are in the new bounded-gap, export and CLI suites, with an appended rendering test. This report records the verification exception without changing the old assertions.

The complete staged diff, including file names and hunk line ranges, is saved locally as `node_modules/.cache/calibration-run2.patch`.
