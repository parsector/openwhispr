# 1.13.4 upgrade fixture

`1.13.4.db.gz` is a compressed SQLite database created by the unmodified
`DatabaseManager` at commit `538c0d02d` (version 1.13.4), using the test Electron
path stub. It is generated application data, not a user's private database.

The generator called `saveNote("upgradecanary", "searchcanary", "meeting")`,
then `updateNote` with `enhanced_content: "summarycanary"`, participants
`[{"email":"a@example.com"}]` and two transcript rows: an undecided legacy
`Outsider` and a user-locked `Chosen`. The database was closed before compression.
It has user_version 5, the original broad FTS update trigger, and no
`speaker_roster_revision` column. Search returned note 1 before upgrade.

Uncompressed SHA-256:
`8fa5f8f7207d54c1fb81289c7e3700b4a37b58688c587a0bda891ef8e406efb3`.

`noteFtsTriggers.test.js` copies the fixture into isolated temporary directories.
One variant inserts duplicate FTS rows and proves corruption before upgrade.
Both then verify version 6, search and index integrity, legacy migration,
second-open stability, participant/text edits, cloud upserts and deletion.
