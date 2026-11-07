# Calibration fix run 6

## Change

`test/lib/tempDir.js` exports `createTempDir(prefix, parent = os.tmpdir())`.
It resolves the prefix, creates its parent with `fs.mkdirSync(parent, { recursive: true })`,
then calls `fs.mkdtempSync`. It supports OS-temp basenames, explicit repo-relative
parents, and absolute prefixes. All 238 existing calls in 133 files now use it,
retaining their previous directory locations, prefixes, cleanup and assertions.
The liveness fixture delegates its previous explicit parent creation to the helper.

`test/lib/tempDirPolicy.test.js` inventories JavaScript and TypeScript under `test/`
and rejects direct filesystem temp-directory API references outside the helper.
The helper is the sole allowlisted file. The guard detects synchronous, asynchronous,
aliased, destructured and computed-property access, and verifies that `createTempDir`
calls import the shared helper. Comments and source-code fixture strings are ignored.
OS-temp calls are also centralized so future callers cannot bypass the rule by
changing an apparently safe parent to a missing repo directory.

Every new test file in the last five commits was checked:
`calibrationBoundedGaps.test.js` and `scripts/calibrate.test.js` needed conversion;
`speakerCalibrationExport.test.js` creates no temporary directories.
No existing assertions, product behavior, version, tags, release configuration or
`CHANGELOG.md` were changed.

## Fail-then-pass evidence

At `1ef671900fc07ca2ba72cdeb18adb6f1c0de7b13`, the original cache was moved to
`/opt/data/cache/scratch/nmcache.hold` and restored through an EXIT trap after:

```sh
node --import tsx --test test/helpers/calibrationBoundedGaps.test.js
```

Exit 1: **26 tests, 19 pass, 7 fail**. Both reported failures were reproduced:

```text
ENOENT: no such file or directory, mkdtemp '.../node_modules/.cache/bounded-gaps-XXXXXX'
ENOENT: no such file or directory, mkdtemp '.../node_modules/.cache/freshness-boundary-XXXXXX'
```

With only the new guard added to that baseline, before the helper or any conversions:

```sh
node --test test/lib/tempDirPolicy.test.js
```

Exit 1: **2 tests, 1 pass, 1 fail**, with policy violations including both
`calibrationBoundedGaps.test.js` call sites and all four `scripts/calibrate.test.js`
call sites. After conversion, the same command exited 0: **2 pass, 0 fail**.
The helper and guard tests together exited 0: **4 pass, 0 fail**.

## Verification

The requested helper/component suite was run twice using exactly this file list:

```sh
node --import tsx --test test/helpers/calibrationLiveness.test.js test/helpers/calibrationSpanContext.test.js test/helpers/calibrationEvidenceIndex.test.js test/helpers/speakerCalibration.test.js test/helpers/speakerInAppCalibration.test.js test/helpers/speakerCalibrationAdmission.test.js test/helpers/speakerCompletionDiagnostic.test.js test/helpers/speakerThresholdApplication.test.js test/helpers/meetingSpeakerReconcile.test.js test/components/speakerCalibrationReport.test.js test/helpers/meetingAudioStore.test.js test/helpers/voiceEnrollment.test.js test/helpers/speakerCalibrationExport.test.js test/helpers/calibrationBoundedGaps.test.js
```

| Check                                                                              | Result                                        |
| ---------------------------------------------------------------------------------- | --------------------------------------------- |
| Requested suite, original cache present                                            | 193 pass, 0 fail, 0 skipped                   |
| Requested suite, cache absent at startup                                           | 193 pass, 0 fail, 0 skipped                   |
| Bounded-gaps file alone, cache absent at startup                                   | 26 pass, 0 fail, 0 skipped                    |
| `node --test test/locales/translationCoverage.test.js`                             | 9 pass, 0 fail, 0 skipped                     |
| `node --import tsx --test test/scripts/calibrate.test.js`, cache absent at startup | 13 pass, 0 fail, 0 skipped                    |
| `node --test test/lib/tempDir.test.js test/lib/tempDirPolicy.test.js`              | 4 pass, 0 fail, 0 skipped                     |
| `npm run lint`                                                                     | Exit 0, zero warnings                         |
| `npm run typecheck`                                                                | Exit 0                                        |
| Other 121 converted test files, concurrency 4                                      | 1536 pass, 0 fail, 12 existing platform skips |
| `git diff --check`                                                                 | Pass                                          |

For each absent-cache run, a `try/finally` block restores the original cache.
Any newly generated cache is moved aside separately; no pre-existing directory is deleted.
Local evidence logs are in `/opt/data/cache/scratch/run6-repro.5rl74w/`.

## Every converted file

- `test/helpers/accountScopeBinding.test.js`
- `test/helpers/accountScopeIpc.test.js`
- `test/helpers/audioActivityDetector.test.js`
- `test/helpers/audioSegmentMerge.test.js`
- `test/helpers/calendarDatabase.test.js`
- `test/helpers/calibrationBoundedGaps.test.js`
- `test/helpers/cliBridgeDictionary.test.js`
- `test/helpers/cliBridgeSnippets.test.js`
- `test/helpers/cliBridgeTranscribe.test.js`
- `test/helpers/commitmentsDatabase.test.js`
- `test/helpers/commitmentsExtract.test.js`
- `test/helpers/commitmentsStore.test.js`
- `test/helpers/connectorActionsDatabase.test.js`
- `test/helpers/connectors/connectorCredentials.test.js`
- `test/helpers/connectors/credentialStore.test.js`
- `test/helpers/containerConversationsDatabase.test.js`
- `test/helpers/cosmicToplevel.test.js`
- `test/helpers/debugLogger.test.js`
- `test/helpers/debugLoggerConsolePolicy.test.js`
- `test/helpers/diarizeAudioFileHandler.test.js`
- `test/helpers/dictionaryDatabase.test.js`
- `test/helpers/downloadUtils.test.js`
- `test/helpers/enterpriseAudioCredentials.test.js`
- `test/helpers/enterpriseAudioSetup.test.js`
- `test/helpers/enterpriseAudioTransport.test.js`
- `test/helpers/enterpriseIdentityManager.test.js`
- `test/helpers/environmentDebugLogLevel.test.js`
- `test/helpers/environmentVoiceAgentHotkey.test.js`
- `test/helpers/exportDialog.test.js`
- `test/helpers/extractArchive.test.js`
- `test/helpers/gemmaMtpDrafter.test.js`
- `test/helpers/gpuBinaryManager.test.js`
- `test/helpers/gpuFallbackLog.test.js`
- `test/helpers/gpuPackMigrationNotice.test.js`
- `test/helpers/granolaImportDatabase.test.js`
- `test/helpers/granolaImportIpc.test.js`
- `test/helpers/harness/db.js`
- `test/helpers/hyprlandConfigPersistence.test.js`
- `test/helpers/hyprlandShortcut.test.js`
- `test/helpers/ipcHandlersCommitmentsDelete.test.js`
- `test/helpers/linuxAutostart.test.js`
- `test/helpers/linuxLauncherSandbox.test.js`
- `test/helpers/linuxUrlSchemeHandler.test.js`
- `test/helpers/liveSpeakerAnchor.test.js`
- `test/helpers/liveSpeakerReconsideration.test.js`
- `test/helpers/localReasoningBridgeChain.test.js`
- `test/helpers/localServerSyncIpc.test.js`
- `test/helpers/macosPasteLayout.test.js`
- `test/helpers/macosPasteRead.test.js`
- `test/helpers/macosPasteTyping.test.js`
- `test/helpers/managedAudioFileTranscription.test.js`
- `test/helpers/markdownMirror.test.js`
- `test/helpers/meetingAudioStore.test.js`
- `test/helpers/meetingDiarizationMemory.test.js`
- `test/helpers/meetingNotificationIpc.test.js`
- `test/helpers/modelDirUtils.test.js`
- `test/helpers/modelManagerBridgeDownloadStatus.test.js`
- `test/helpers/modelManagerContextSizing.test.js`
- `test/helpers/noteCloudUpsertGuard.test.js`
- `test/helpers/notesOwnerDatabase.test.js`
- `test/helpers/orukeetDictationIpc.test.js`
- `test/helpers/paidKeyCheck.test.js`
- `test/helpers/parakeetModelManifest.test.js`
- `test/helpers/parakeetWavNormalization.test.js`
- `test/helpers/peopleActions.test.js`
- `test/helpers/personalAudioPolicy.test.js`
- `test/helpers/productHelp.test.js`
- `test/helpers/providerConnectionIpc.test.js`
- `test/helpers/providerUploadAudio.test.js`
- `test/helpers/routineCustomAuth.test.js`
- `test/helpers/routineEventTriggers.test.js`
- `test/helpers/routineSlice2b.test.js`
- `test/helpers/routineSmoke.test.js`
- `test/helpers/routineTitleTemplate.test.js`
- `test/helpers/secretCryptoBackup.test.js`
- `test/helpers/secretKeys.test.js`
- `test/helpers/sharedDictionaryDatabase.test.js`
- `test/helpers/sidecarPidFile.test.js`
- `test/helpers/sidecarReaper.test.js`
- `test/helpers/skills/libraryFixture.js`
- `test/helpers/skills/skillLibrary.test.js`
- `test/helpers/snippetsDatabase.test.js`
- `test/helpers/spacesDatabase.test.js`
- `test/helpers/speakerAccuracyEval.test.js`
- `test/helpers/speakerCalibration.test.js`
- `test/helpers/speakerEmbeddingsClusterCentroids.test.js`
- `test/helpers/speakerInAppCalibration.test.js`
- `test/helpers/speakerThresholdApplication.test.js`
- `test/helpers/streamingStartAudioIpc.test.js`
- `test/helpers/textEditMonitorWindowBounds.test.js`
- `test/helpers/transcriptRetention.test.js`
- `test/helpers/transcriptionModelDownloadStatus.test.js`
- `test/helpers/translationHistory.test.js`
- `test/helpers/uiLanguageStartup.test.js`
- `test/helpers/updater.test.js`
- `test/helpers/urlAudioDownloader.test.js`
- `test/helpers/vectorChangesDatabase.test.js`
- `test/helpers/voiceEnrollment.test.js`
- `test/helpers/voiceExemplarAudio.test.js`
- `test/helpers/voiceSurfaceGeometryDevServer.test.js`
- `test/helpers/whisperGpuFailureRecordIpc.test.js`
- `test/helpers/whisperGpuResolve.test.js`
- `test/helpers/whisperGpuUpgradeReset.test.js`
- `test/helpers/whisperServerGpuFailureReason.test.js`
- `test/helpers/whisperVadModelPath.test.js`
- `test/helpers/workspacePolicyCache.test.js`
- `test/helpers/workspacePolicyManager.test.js`
- `test/lib/calibrationLivenessFixture.js`
- `test/lib/linuxFastPasteFixture.js`
- `test/lib/rendererTestHarness.js`
- `test/scripts/afterPackWindowsKeyListener.test.js`
- `test/scripts/afterPackWindowsOnnxRuntime.test.js`
- `test/scripts/calibrate.test.js`
- `test/scripts/downloadSherpaOnnx.test.js`
- `test/scripts/downloadUtils.test.js`
- `test/scripts/downloadWhisperCpp.test.js`
- `test/scripts/extractReleaseNotes.test.js`
- `test/scripts/injectReleaseNotes.test.js`
- `test/services/agents/jobManager.test.js`
- `test/services/agents/openTerminal.test.js`
- `test/services/agents/presetStore.test.js`
- `test/services/agents/projectStore.test.js`
- `test/services/agents/resume.test.js`
- `test/services/agents/worktree.test.js`
- `test/services/assistantNoteUndo.test.js`
- `test/services/mcp/client/client.test.js`
- `test/services/mcp/server.test.js`
- `test/services/noteEditPersistence.test.js`
- `test/services/openwhisprReasonPurpose.test.js`
- `test/services/promptStudioAgentPurpose.test.js`
- `test/services/todoWrites.test.js`
- `test/tools/selectAffectedTests.test.js`
- `test/utils/meetingAudioPlaybackChain.test.js`
