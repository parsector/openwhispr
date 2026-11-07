# Calibration fix run 7

Regenerate the native routine bundle with `npm run compile:routine-tools` and
commit `src/helpers/routines/generated/toolAssembly.cjs`. Generator environments
can assign different short identifiers, so byte comparison alone can reject an
otherwise equivalent bundle. The check now uses a byte-equality fast path, then
compares scope-aware normalized tokens: declarations and their references share
canonical binding IDs, while strings, property keys, globals, operators and
binding relationships are preserved. Invalid JavaScript fails closed. Generation
itself is unchanged. Both `predev` and `prebuild` already start with
`npm run compile:routine-tools` at the supplied baseline; those hooks are retained
and covered by a regression test. No generation was added to `pretest`, so the
gate still detects stale artifacts without rewriting them.

The incoming regenerated artifact was kept. Its md5 before generation and after
successive fresh generations was **2636e9b20758933c68b2ea33c7a3b88e**. Verification
also found substantive locale drift in the old committed artifact: for example,
it lacks the current `audio_evidence` property. Normalization correctly rejects
that older artifact; the actual diff is not exclusively identifier renaming.

## Fail-then-pass demonstration

An isolated copy of `src/`, the generator scripts and `package.json` was created
under `node_modules/.cache/routine-run7-CrFdlp/`, using the existing dependencies.
In that copy, 18 identifier tokens were swapped (`Mi`/`Ni`, `Ml`/`Nl`) without
changing strings or property names. The bytes changed, but this command exited 0:

```sh
node scripts/build-routine-tool-assembly.js --check
```

After restoring the bundle, the instruction string in the copied
`src/services/tools/productHelpTools.ts` was prefixed with
`RUN 7 STALENESS PROBE.`. Without regenerating the artifact, the same command
exited 1 and printed:

```text
Routine tool assembly is stale; run npm run compile:routine-tools
```

Restoring the instruction made the check exit 0. The scratch source and artifact
were restored, verified against the originals, and the scratch directory removed.
The working source was never edited for these probes. Regression tests also
cover nested bindings, changed instructions, changed properties/globals/imports,
changed binding use, shorthand property keys and invalid syntax.

## Verification

Linux, Node v26.7.0, esbuild 0.28.1. Both requested registry filenames exist.

Changed ranges: `scripts/build-routine-tool-assembly.js` lines 21–36;
new `scripts/lib/normalize-routine-tool-assembly.js` lines 1–66;
new `test/scripts/buildRoutineToolAssembly.test.js` lines 1–50;
31 regenerated lines across `src/helpers/routines/generated/toolAssembly.cjs`
lines 1–1425; and this new report.

| Command                                                                                                             | Result                         |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `npm run compile:routine-tools`                                                                                     | Exit 0; unchanged artifact md5 |
| `git status --porcelain` after commit and regeneration                                                              | Empty                          |
| `node --import tsx --test test/helpers/routineToolRegistry.native.test.js test/helpers/routineToolRegistry.test.js` | 3 pass, 0 fail                 |
| `node --test test/scripts/buildRoutineToolAssembly.test.js`                                                         | 5 pass, 0 fail                 |
| `node --import tsx --test test/helpers/calibrationBoundedGaps.test.js test/helpers/speakerInAppCalibration.test.js` | 42 pass, 0 fail                |
| `npm run lint`                                                                                                      | Exit 0, zero warnings          |
| `npm run typecheck`                                                                                                 | Exit 0                         |
| `git diff --check`                                                                                                  | Exit 0                         |
