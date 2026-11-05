# Calibration evidence integrity — slice 1

Implemented on `fix/calibration-evidence-integrity`, based on `4e9b938a0`.

The failure was that the sweep winner doubled as a recommendation. Refusal could maximize the unchanged objective, and reconstructed vectors could satisfy the old gate without production validation. Recommendations now require a separate admission result. The current reconstruction job returns diagnostics with no recommendation or Apply action.

## Result contract

`src/types/speakerCalibration.ts:68` defines the discriminated union. The report builder emits version 3 at `src/helpers/speakerInAppCalibration.js:191`:

```ts
{
  version: 3,
  resultType: "supported_recommendation" | "diagnostic_only",
  recommended: { similarityFloor, runnerUpMargin } | {},
  policy: { /* named admission minimums and owner targets */ },
  evidenceScope: { tuningSessions, evaluationSessions, evaluationSource },
  validation: {
    rows, positives, negatives, accepted, right, wrong, refused,
    correctNameCoverage, precision, checks
  },
  failedCriteria: string[],
  nextAction: "collect_independent_production_evidence" | null,
  uncertainty: string[],
  evidence: { /* measured counts, exclusions, revisions, completion diagnostics */ },
  analyses: { calibration: { rows, table, winner } },
  // Existing identity, scope, fingerprints, support and method fields remain.
}
```

`diagnostic_only` always has `recommended: {}`. Its sweep winner stays inside the diagnostic analysis and is never rendered as the outcome. The supported branch includes the selected thresholds, independent validation metrics, evidence scope and finite-holdout/current-profile limitations. Duration and overlap remain unevaluated in both branches.

## Admission criteria

All thresholds are named in `src/helpers/speakerCalibrationPolicy.js:2`. Every failed check is returned by name at line 126. Admission is implemented at these locations:

| Criterion | Requirement | File:line |
| --- | --- | --- |
| `real_evidence` | Synthetic performance evidence cannot qualify. | `src/helpers/speakerCalibrationPolicy.js:90` |
| `reviewed_rows` | At least 30 reviewed rows. | `src/helpers/speakerCalibrationPolicy.js:91` |
| `notes` | At least three notes. | `src/helpers/speakerCalibrationPolicy.js:92` |
| `people` | At least two reviewed people. | `src/helpers/speakerCalibrationPolicy.js:93` |
| `profiles` | At least two current profiles. | `src/helpers/speakerCalibrationPolicy.js:94` |
| `machine_claims` | At least ten recorded machine claims. | `src/helpers/speakerCalibrationPolicy.js:95` |
| `analysis_rows` | At least twelve consistent diagnostic examples. | `src/helpers/speakerCalibrationPolicy.js:96` |
| `model_fingerprint`, `profile_fingerprint` | Valid SHA-256 identities. | `src/helpers/speakerCalibrationPolicy.js:97` |
| `audio_fingerprints` | Valid, consistent retained-audio fingerprints for included notes/rows. | `src/helpers/speakerCalibrationPolicy.js:99` |
| `production_parity` | Production decision observations at the frozen candidate thresholds, with matching model/profile fingerprints and valid labels. | `src/helpers/speakerCalibrationPolicy.js:103` |
| `independent_sessions` | Explicit recording-session identities for all tuning/evaluation examples; no shared session. Different notes from one session do not qualify. | `src/helpers/speakerCalibrationPolicy.js:110` |
| `positive_coverage` | Holdout includes enrolled people. | `src/helpers/speakerCalibrationPolicy.js:115` |
| `negative_coverage` | Holdout includes unenrolled or unknown people. | `src/helpers/speakerCalibrationPolicy.js:116` |
| `declared_targets` | Owner-declared coverage and precision targets in (0, 1]. | `src/helpers/speakerCalibrationPolicy.js:117` |
| `nonempty_accepted_set` | Both the sweep winner and holdout accept names. | `src/helpers/speakerCalibrationPolicy.js:118` |
| `correct_name_coverage` | Correct accepted names / enrolled positive examples meets the declared minimum. | `src/helpers/speakerCalibrationPolicy.js:119` |
| `precision` | Correct accepted names / all accepted names meets the declared minimum. False accepts on negatives count against precision. | `src/helpers/speakerCalibrationPolicy.js:122` |

Application requires version 3 and supported admission (`src/helpers/speakerCalibrationAction.js:14`, `src/helpers/speakerDecisionThresholds.js:106`). New persisted evidence retains the admission summary for reload. Existing legacy applied values and runtime statuses are preserved: invalidating their statuses would change the production naming floor, which is outside this slice.

## Completion messages

Display derives from `vectorsWritten`, `clusters` and the recorded `cause`; the storage semantics of `had_speaker_embeddings` are unchanged. The helper keeps the exact cause, translates its category, and distinguishes skipped/failed diarization, extraction failure, persistence rejection, key mismatch, missing completion, unavailable model/audio, no eligible segments, and unknown. Ambiguous migrated zero counters become `null` in the display contract and render **not recorded**, never a fabricated `0 of 0` measurement (`src/helpers/speakerCompletionDiagnostic.js:8`). Explicit causes with measured zero counters remain measurable zeros.

## Changed files

The areas below use new-file line numbers; removed duplicate tables and types are represented by their replacement locations.

| File | Changed areas | Rationale |
| --- | --- | --- |
| `src/helpers/speakerCalibrationPolicy.js` | 1–164, new | Centralize admission constants, session separation, holdout metrics and named failures. |
| `src/helpers/speakerInAppCalibration.js` | 5–6, 92–93, 114–243, 271–344, 431–437 | Emit the new contract, run one diagnostic sweep, remove the duplicate live-vector analysis, and preserve completion causes. |
| `src/helpers/speakerCompletionDiagnostic.js` | 1–57, new | Translate actual causes and represent unmeasured counters honestly. |
| `src/helpers/speakerCalibrationAction.js` | 4, 14–15 | Reject unsupported and legacy reports as new recommendations. |
| `src/helpers/speakerDecisionThresholds.js` | 3, 31–44, 106–138, 157–162 | Enforce new admissions while preserving manual saves and existing runtime settings. |
| `src/helpers/ipcHandlers.js` | 15321, 15368, 15807 | Record distinct skipped and failed diarization completion causes. |
| `src/components/settings/PeoplePage.tsx` | 28, 381, 2058–2061 | Guard Apply by result type and delegate result rendering. |
| `src/components/settings/SpeakerCalibrationReport.tsx` | 1–130, new | Render diagnostic reasons and one sweep; show recommendation/Apply only for supported results. |
| `src/types/speakerCalibration.ts` | 1–72, new | Define the report union and structured measurements. |
| `src/types/electron.ts` | 3986 | Use the shared report type at the IPC boundary. |
| `src/locales/ar/translation.json` | 6272–6320 | Translate new report, admission and completion messages into Arabic. |
| `src/locales/de/translation.json` | 6038–6086 | Translate the new messages into German. |
| `src/locales/en/translation.json` | 6038–6086 | Define the English messages and interpolation contract. |
| `src/locales/es/translation.json` | 6056–6104 | Translate the new messages into Spanish. |
| `src/locales/fr/translation.json` | 6056–6104 | Translate the new messages into French. |
| `src/locales/it/translation.json` | 6056–6104 | Translate the new messages into Italian. |
| `src/locales/ja/translation.json` | 6038–6086 | Translate the new messages into Japanese. |
| `src/locales/pt/translation.json` | 6056–6104 | Translate the new messages into Portuguese. |
| `src/locales/ru/translation.json` | 6140–6188 | Translate the new messages into Russian. |
| `src/locales/zh-CN/translation.json` | 6038–6086 | Translate the new messages into Simplified Chinese. |
| `src/locales/zh-TW/translation.json` | 6038–6086 | Translate the new messages into Traditional Chinese. |
| `scripts/fixtures/benchmark-in-app-calibration.js` | 153–154 | Consume the single diagnostic analysis and new result type. |
| `test/helpers/speakerCalibrationAdmission.test.js` | 1–198, new | Exercise independent admission, every failed minimum, refusal, targets and apply rejection. |
| `test/helpers/speakerCompletionDiagnostic.test.js` | 1–140, new | Exercise each cause, migrated counters, label preservation and dynamic locale keys. |
| `test/helpers/speakerInAppCalibration.test.js` | 4, 19–170, 203, 316, 422, 450, 524–525, 627–628 | Lock down refusal/ties and replace obsolete duplicate-analysis expectations. |
| `test/helpers/speakerThresholdApplication.test.js` | 6–7, 47–59, 74–132 | Verify supported application, diagnostic rejection, manual values and legacy compatibility. |
| `test/helpers/meetingSpeakerReconcile.test.js` | 580–621 | Verify real producers persist skipped/failed causes before announcing completion. |
| `test/components/speakerCalibrationReport.test.js` | 1–115, new | Render actual UI for diagnostic/supported states and every completion cause. |
| `test/lib/speakerRecommendationFixture.js` | 1–43, new | Provide disjoint tuning/holdout sessions with test-only policy targets. |
| `docs/speaker-calibration.md` | 5–22 | Replace the former three-analysis claims with the truthful contract and limits. |
| `docs/calibration-evidence-integrity-report.md` | New | Record implementation, admission references, validation and remaining limits. |

## Verification

First command: `npm run lint`. The first attempt failed because dependencies were absent (`eslint: not found`). After `npm ci --ignore-scripts`, the final `npm run lint` exited 0 without warnings. Dependency manifests and the lockfile were unchanged.

Focused command:

```sh
node --test test/helpers/speakerCalibration.test.js test/helpers/speakerInAppCalibration.test.js test/helpers/speakerCalibrationAdmission.test.js test/helpers/speakerCompletionDiagnostic.test.js test/helpers/speakerThresholdApplication.test.js test/helpers/meetingSpeakerReconcile.test.js test/components/speakerCalibrationReport.test.js test/components/peopleSelectCheck.test.js test/components/speakerUndoOrderCopy.test.js test/components/speakerSurfaceGuard.test.js test/components/fieldDirectionPolicy.test.js
```

Selected real pass output covering the required regressions:

```text
✔ all-refusal evidence is diagnostic_only with no recommendation
✔ tied profiles never report calibrated
✔ one machine claim fails the existing minimum even with an independent holdout
✔ independent production holdout with declared targets supports a recommendation
✔ exactly one reconstructed diagnostic sweep is produced
✔ universal refusal cannot qualify even when independent validation would pass
✔ empty accepted holdout cannot qualify regardless of the tuning winner
✔ different notes from the same recording session cannot form an independent holdout
✔ production parity requires production decisions at the frozen candidate and fingerprints
✔ independent evaluation requires both enrolled positives and unenrolled negatives
✔ correct-name coverage and precision are separate admission requirements
✔ unset product targets prevent admission rather than inventing goals
✔ completion cause renders its own message: diarization skipped
✔ completion cause renders its own message: diarization failed
✔ completion cause renders its own message: extraction failed
✔ completion cause renders its own message: persistence rejected
✔ completion cause renders its own message: speaker key mismatch
✔ completion cause renders its own message: no completion event
✔ completion cause renders its own message: migrated zero counters
✔ completion cause renders its own message: unknown legacy completion
✔ completion cause renders its own message: model unavailable
✔ completion cause renders its own message: no eligible segments
✔ completion cause renders its own message: audio unavailable
✔ People calibration all-refusal UI shows diagnostics, one sweep, and no apply action or recommendation panel
✔ People calibration shows the apply action only for an independently supported recommendation
✔ People calibration renders each completion cause and migrated counts as not recorded
✔ legacy applied settings retain their production values and status on reload
ℹ tests 81
ℹ pass 81
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

`node --test test/locales/translationCoverage.test.js` exited 0:

```text
✔ every t() key referenced in source resolves in en
✔ every model registry descriptionKey resolves in en
✔ every en key is present in every other language
✔ interpolation variables match en in every language
✔ every messageKey literal resolves in en
✔ Arabic defines every CLDR plural category for each counted message
✔ the dictionary's counted strings define every plural form they need
✔ Arabic non-count numeric templates remain number-neutral
✔ Arabic plural counts resolve the exact CLDR form without English fallback
ℹ tests 9
ℹ pass 9
ℹ fail 0
```

`npm run typecheck` exited 0. `npm run build:renderer` exited 0 with `✓ 2097 modules transformed` and `✓ built in 7.63s`. Vite retained its large-chunk warning. The reconciliation suite emitted an existing `MODULE_TYPELESS_PACKAGE_JSON` warning for `llmRequestTimeout.js`; no tests failed.

The Impeccable detector returned `[]`. Browser inspection used the rendered report and built CSS at 1024px and 390px, including Arabic RTL. All four samples had document width equal to viewport width. Diagnostic samples had zero Apply buttons; the supported fixture had one. Local screenshot artifacts (ignored, outside the commit) are under `node_modules/.cache/calibration-evidence-integrity/`: `diagnostic-desktop.png`, `diagnostic-mobile.png`, `diagnostic-arabic-mobile.png`, and `supported-desktop.png`. These are fixture renders, not production screenshots.

## Intentional limits

`minimumCorrectNameCoverage` and `minimumPrecision` remain `null` for the owner to set before evaluation. The illustrative fixture targets 0.8 and 0.95 are test inputs only. Acquisition of independent production observations and verified session provenance remains later work, so the current in-app job cannot issue a supported recommendation. No evidence-snapshot schema, shared production decision module or profile-check experiment was added.

Recognition math, the sweep objective, normalization, all four threshold defaults, retention and enrollment storage were left unchanged. Legacy applied runtime settings were preserved. Display derives from counters rather than redefining `had_speaker_embeddings`.

`git status --porcelain` was reviewed and showed only the intended implementation, locale, test, fixture and documentation files; generated build and screenshot artifacts are ignored. No push, PR or release was performed.
