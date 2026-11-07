# Calibration fix run 4

## Root causes and changes

- At `f94b82edf`, `src/helpers/speakerInAppCalibration.js:738` checked each saved included row but never recomputed the selected membership used by cluster conflict exclusion. An untouched Ada/r1 therefore stayed fresh after adding reviewed Ben/r2 to the same note and cluster, although rebuilding excluded both. Reports now save each included non-exemplar cluster's row IDs and reviewed labels, bind that snapshot to the included revisions, and reselect candidates with the original scope, note/row budgets, review rules and exemplar suppression. `reportStillCurrentLocal` compares eligible membership at every local/worker freshness boundary. It measures new siblings with the same bounded extraction function as report generation. Excluded, unbounded, unreviewed, out-of-budget and unrelated-cluster evidence does not become a dependency. Included rows retain their revision, removal, WAV, recording and manifest checks; model, profile and exemplar checks remain. No centroid dependency was added.
- At `f94b82edf`, `src/helpers/calibrationEvidenceWindow.js:3` omitted the app's 1.5-second minimum and exact retained-sample coverage; `scripts/calibrate.js:112` measured `start/end` after whole-track resampling while the app requested resolved `from/to`. The shared helper now enforces the non-exemplar minimum before resampling and validates exact coverage of the common measurement window. Both consumers slice resolved source PCM first, then share conversion to 16 kHz. Exports preserve retained sample ranges because WAV export fills recording gaps with silence; the CLI checks those ranges as well as the physical WAV boundary.

The shared rounding rule lives in `src/helpers/calibrationEvidenceWindow.js:10` (`measurementInterval`): keep the resolver's existing millisecond rounding, select `from/to`, and apply `Math.round(seconds * 24000)` to each endpoint. Coverage is exact in sample space, with no millisecond tolerance or end clipping. After slicing, `pcm16Samples` floors the 16 kHz output count and source index, matching the app's existing conversion. `meetingAudioSpan.mjs` is unchanged.

Admission targets, thresholds, scoring/cohort calculations, enrollment, retention, versions and `CHANGELOG.md` are unchanged. The six earlier fixes and both assertions changed in `f94b82edf` are preserved; no existing assertion was edited.

## Fail-then-pass evidence

Before production edits, these commands exercised the new regressions:

```sh
node --import tsx --test --test-name-pattern='freshness sees|measurement rejects' test/helpers/calibrationBoundedGaps.test.js
node --test --test-name-pattern='CLI rejects' test/scripts/calibrate.test.js
```

Observed output: helper tests **0 pass, 3 fail, 0 skipped**; CLI tests **0 pass, 2 fail, 0 skipped**.

| Reproduction | Before | After |
| --- | --- | --- |
| Reviewed Ada/r1; add bounded reviewed Ben/r2 in the same note and cluster, preserving r1 | Rebuilt report excluded both, but freshness returned `true` (`true !== false`) | Freshness returns `false`; rebuilt report has zero included rows and two `conflicting_reviewed_labels` exclusions |
| 24 kHz stored span `[24001,60000)` (1.499958 seconds) | App rejected it, helper returned `null` instead of `span_too_short`; CLI exclusions were `[]` | Shared helper and app return `span_too_short`; CLI excludes it before measurement and scores only four valid fixture rows |
| Label `[1,3]`, retained `[0,72013)`, resolved `[0.96,3.001]` | Helper returned `null` instead of `window_retained_coverage`; CLI exclusions were `[]` | Both reject the common window ending at sample 72024, beyond retained sample 72013; app never calls the decoder |

Additional regressions cover an emptied membership snapshot, irrelevant/ineligible siblings, exported silence padding, retained-range export, and a non-synthetic CLI run that checks every embedding input PCM sample against the expected source slice and resampling rule.

A further freshness regression changes the recording time origin while preserving the included transcript row and retained bytes. It failed with `true !== false` before matching reselected rows by note/row identity, and passes after that adjustment: changed derived measurement coordinates are stale even when the evidence fingerprint key changes.

Intermediate full runs exceeded the existing 50 ms liveness CPU limit (63.3, 53.8, 53.4 and 51.5 ms); assertions were kept unchanged. Profiling identified a long interval around worker report delivery. The final implementation sends the full membership snapshot as serialized JSON and does not duplicate cluster/label data in revisions, avoiding another nested row-sized object graph on the main thread. The subsequent full 183-test run passed with a 16.6 ms maximum CPU slice. The final run below also includes the additional derived-window regression. Earlier failed logs and the CPU profile remain with the local verification artifacts.

## Changed file ranges

Ranges refer to the resulting files (inclusive):

- `src/helpers/calibrationEvidenceWindow.js:3-57`: common minimum, interval, exact coverage and PCM conversion.
- `src/helpers/speakerInAppCalibration.js:14,26-43,168,351-353,529,565-597,650-661,775-839`: membership snapshot, shared measurement, freshness replay.
- `src/helpers/speakerCalibrationExport.js:115-139`: shared exclusion and retained sample ranges in exports.
- `scripts/calibrate.js:6-136`: source-window measurement and common validation/conversion.
- `test/helpers/calibrationBoundedGaps.test.js:62-67,260-366`: fixture budget support and helper/freshness regressions.
- `test/helpers/speakerCalibrationExport.test.js:22-41`: retained-range export regression.
- `test/scripts/calibrate.test.js:43-121`: CLI boundary and PCM regressions.

## Verification

Final verification results and exact commands are recorded below. Full output artifacts are in `node_modules/.cache/calibration-run-4/` (ignored, local only). Renderer output is in `src/dist/` (ignored).


```sh
node --import tsx --test test/helpers/calibrationLiveness.test.js test/helpers/calibrationSpanContext.test.js test/helpers/calibrationEvidenceIndex.test.js test/helpers/speakerCalibration.test.js test/helpers/speakerInAppCalibration.test.js test/helpers/speakerCalibrationAdmission.test.js test/helpers/speakerCompletionDiagnostic.test.js test/helpers/speakerThresholdApplication.test.js test/helpers/meetingSpeakerReconcile.test.js test/components/speakerCalibrationReport.test.js test/helpers/meetingAudioStore.test.js test/helpers/voiceEnrollment.test.js test/helpers/speakerCalibrationExport.test.js test/helpers/calibrationBoundedGaps.test.js
node --test test/locales/translationCoverage.test.js
node --import tsx --test test/scripts/calibrate.test.js
npm run lint
npm run typecheck
npm run build:renderer
```

The commands were executed with stdout/stderr redirected to the corresponding local log files. Final observed output:

| Command | Result | Output artifact |
| --- | --- | --- |
| Helper/component suite above | 184 tests, 184 pass, 0 fail, 0 skipped; maximum liveness CPU slice 27.0 ms | `helpers.log` |
| Translation coverage | 9 tests, 9 pass, 0 fail, 0 skipped | `locales.log` |
| CLI suite | 5 tests, 5 pass, 0 fail, 0 skipped | `cli.log` |
| `npm run lint` | Exit 0; ESLint completed with `--max-warnings=0` | `lint.log` |
| `npm run typecheck` | Exit 0; `tsc --noEmit` | `typecheck.log` |
| `npm run build:renderer` | Exit 0; 2097 modules transformed; Vite's existing large-chunk advisory remains | `renderer.log` |

No skips were introduced. `git diff --check` passed. Renderer artifacts: `src/dist/`.
