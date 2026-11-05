# Approved voice clips

This clip is kept until you erase it by deleting the person, clearing all voice data, resetting their voice, removing the sample, or undoing its approval. Recording retention, eviction, note deletion, re-diarisation and app restart never erase it.

Approved clips belong to the person and are saved with their approval in local encrypted storage. They remain playable independently of the source recording and note. Removing a saved clip is irreversible: undo can restore identity and speaker mappings, but cannot recover erased audio or biometric vectors. Resetting a person's voice also erases vectors from earlier merge owners' undo snapshots, including legacy profiles without saved audio.

**Legacy approvals are recovered automatically at startup while their source audio still exists. Recovered samples count normally, without another review. Samples whose audio has already expired cannot be recovered: they become permanently ineligible for recognition and recording diversity, and may require re-enrolment.** People shows their voice as unavailable and explains this consequence.

Every consumer uses one provenance classifier: `resolved(recordingId)`, `pending_recovery`, or `unrecoverable`. An approval records its identity from the real recording manifest in the approval transaction. Unknown provenance contributes no recording count, centroid vote, recognition profile or calibration vector. Such samples stay pending until startup recovery finds the actual recording UUID. Notes, transcript IDs, cached profile vectors, directories, timestamps and deletion tombstones cannot establish provenance. A resolved identity cannot be replaced later.

Startup recovery runs before the recording store's first retention sweep, including at the sample cap. It preserves the approved interval, WAV bytes, vector, ID and approval time in encrypted person-owned storage. The startup recovery report logs recovered, resolved, pending and unrecoverable counts with per-sample failure reasons; People shows the recovered count and recovery consequences. Missing encryption keys defer recovery and hold the affected source recordings out of automatic expiry and eviction until a later startup can recover them; explicit owner deletion still erases them. Subsequent starts leave recovered clips unchanged. If audio survives but its real recording UUID is missing, its clip remains pending and unavailable for recognition until a manifest supplies the UUID.

Startup also repairs irreversible historical removals directly from their removal snapshots and durable ownership links, independently of the bounded global history list. Reversible legacy vector-only removals keep their exact undo vector. Erasing a sample remains irreversible even after its history row is pruned.

Tests cover logical erasure from live rows and affected undo snapshots. Physical erasure from SQLite free pages, WAL files or backups is unverified.
