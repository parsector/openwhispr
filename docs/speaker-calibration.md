# Speaker calibration in Settings → People

Choose **All finished notes** or a date range, set the note and reviewed-row budgets, and select **Run calibration**. The job reads owner-reviewed speaker labels already in saved meeting transcripts. It runs behind the renderer, shows progress, rows re-embedded and bytes read, and can be cancelled. No export or import is needed. Applying the report is a separate action, recorded in the ordered People action history. Undo restores the preceding values and per-threshold statuses without changing transcript corrections.

The report keeps two analyses apart:

- **Measured against your profiles as they are today:** the final pass similarity floor and runner-up margin sweep reuses stored cluster centroids and compares them with the current profile embeddings. The stored centroid comparison is reproducible, but it does not replay the profiles or other conditions from the original decision.
- **Estimate:** reviewed transcript row spans are decoded from retained 32 kb/s Opus audio and re-embedded with the local speaker model. These row-window embeddings are not the live speech windows, which were not persisted. A live query may differ from its running centroid by up to 2 in cosine. The table estimates live threshold behavior only; it is not a live replay.

A report needs at least 30 reviewed rows across three notes and two people, ten machine claims, twelve stored clusters, a method and identity, exact scope, row revisions, exclusions, and audio/model/profile fingerprints before a threshold can be marked calibrated. Support is checked separately for every threshold. Reports are tied to the current row revisions, recordings and profile embeddings; changes require a new run. The fixed automatic-naming floor of 0.60 is shown before similarity floor calibration; after calibration the automatic naming path uses the applied value.

**No recommendation is made for `minimumVoicedSeconds` or `overlapToleranceSeconds` from history.** The production voiced-seconds gate used the matched diarization turn's duration, which was not stored. The stored overlap flag is only an outcome at one tolerance. The original matched turns and overlap intervals, or an exact way to rederive them, are needed to sweep those parameters. Both remain visibly uncalibrated.

The older `npm run calibrate -- --meeting <exported-folder>` tool remains for explicit offline experiments. Its rows are compared with leave-one-row-out centroids made from the owner's labels in that export. That is a different profile set and method from both production comparison paths above. Its version 1 reports cannot mark in-app thresholds calibrated.
