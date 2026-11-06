Copy correction for enrolment retention on `fix/enrolment-audio-retention`, based on `b30404e27`.

Both People keys now describe the seven-day hold as source protection. Normal recording retention can delete the source after protection ends; expiry does not promise erasure of evidence or approval vectors. The approval record, need for new audio, and re-enrolment consequences remain described. Runtime behavior is unchanged.

The browser check asserts both complete English strings and the existing permanent-ineligibility disclosure. The test server permits port fallback so an occupied default port does not block this isolated check. Screenshots use a new prefix to preserve earlier evidence.

Changed source files and new line ranges:

| File | Changed lines |
| --- | --- |
| `docs/voice-exemplar-retention.md` | 3, 11–15 |
| `src/locales/ar/translation.json` | 6232, 6236 |
| `src/locales/de/translation.json` | 5998, 6002 |
| `src/locales/en/translation.json` | 5998, 6002 |
| `src/locales/es/translation.json` | 6016, 6020 |
| `src/locales/fr/translation.json` | 6016, 6020 |
| `src/locales/it/translation.json` | 6016, 6020 |
| `src/locales/ja/translation.json` | 5998, 6002 |
| `src/locales/pt/translation.json` | 6016, 6020 |
| `src/locales/ru/translation.json` | 6100, 6104 |
| `src/locales/zh-CN/translation.json` | 5998, 6002 |
| `src/locales/zh-TW/translation.json` | 5998, 6002 |
| `test/browser/voiceExemplarPlayback.cjs` | 42, 82–85, 91–92, 111 |

Verification commands and actual output (all exit 0):

`npm run lint`

```text
npm notice run open-whispr@1.13.0 lint
npm notice run eslint . --max-warnings=0 && cd src && eslint . --max-warnings=0
```

`node --test test/locales/translationCoverage.test.js`

```text
✔ every t() key referenced in source resolves in en (126.897362ms)
✔ every model registry descriptionKey resolves in en (11.003902ms)
✔ every en key is present in every other language (106.84055ms)
✔ interpolation variables match en in every language (311.739998ms)
✔ every messageKey literal resolves in en (84.614868ms)
✔ Arabic defines every CLDR plural category for each counted message (9.954759ms)
✔ the dictionary's counted strings define every plural form they need (56.969047ms)
✔ Arabic non-count numeric templates remain number-neutral (8.135311ms)
✔ Arabic plural counts resolve the exact CLDR form without English fallback (38.43797ms)
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 920.745781
```

`RAYON_NUM_THREADS=2 node --test test/browser/voiceExemplarPlayback.cjs`

```text
✔ person row wires mocked exemplar WAV playback and preserves missing-key errors without loading notes (8790.9017ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9585.546555
```

`git diff --check` passed with no output.

Earlier browser attempts identified an occupied port and an overly strict text matcher: the failure message shares a paragraph with the general recovery disclosure. The final matcher checks the full failure message within that paragraph. Diagnostic logs remain in this directory as `copy-browser.log`, `copy-browser-diagnostic.log`, and `copy-browser-retry.log`. The failed startup attempts were terminated by their exact, verified task-owned process IDs.

Verification logs: `artifacts/enrolment-audio-retention/copy-lint-final.log`, `artifacts/enrolment-audio-retention/copy-translations.log`, `artifacts/enrolment-audio-retention/copy-browser-final.log`.

Browser screenshots:

- `artifacts/enrolment-audio-retention/copy-1440-light.png`
- `artifacts/enrolment-audio-retention/copy-1440-dark.png`
- `artifacts/enrolment-audio-retention/copy-412-light.png`
- `artifacts/enrolment-audio-retention/copy-412-dark.png`

This report and the four screenshots are additional verification artifacts.

