# Approved voice clips

This clip is kept until you erase it by deleting the person, clearing all voice data, resetting their voice, removing the sample, or undoing its approval. Recording retention, eviction, note deletion, re-diarisation and app restart never erase it.

Approved clips belong to the person and are saved with their approval in local encrypted storage. They remain playable independently of the source recording and note. Removing a saved clip is irreversible: undo can restore identity and speaker mappings, but cannot recover erased audio or biometric vectors. Resetting a person's voice also erases vectors from earlier merge owners' undo snapshots, including legacy profiles without saved audio.

Recording diversity requires resolved recording provenance. Unknown provenance contributes no recording count and no centroid vote. Distinct note IDs are not proof of distinct recordings.

Startup repairs historical vector snapshots for removals explicitly marked irreversible by the earlier implementation. Reversible legacy vector-only removals keep their undo data. Existing legacy approvals are not backfilled with saved audio, and previously deleted audio is not recovered.

Tests cover logical erasure from live rows and affected undo snapshots. Physical erasure from SQLite free pages, WAL files or backups is unverified.
