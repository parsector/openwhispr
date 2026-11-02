# People row layout verification

The renderer was run in Chromium at 1440 px and 412 px in light and dark themes. Its People APIs were served from a temporary SQLite fixture created with `DatabaseManager`, `listPeople`, `listReviewRows`, and `previewPersonAction`. The fixture covered a distinct name and email, an address used as the name, zero meetings, near duplicates, legacy provisional voice, a graduated voice with three clean spans from two meetings, a long Greek name and email, and one review queue row. The Alexandra fixture had 10 meetings, 10 notes, 895 segments, and a last seen date of 30 Oct 2026.

The first row measured **176 px at 1440 px** and **240 px at 412 px** in both themes. The fixture had no horizontal page overflow. Enter and Space opened the overflow; Escape closed it and returned focus. An outside click closed it and returned focus. Escape canceled inline rename and returned focus to the pencil. The review row and the primary Enrol voice and Review spans paths were reachable, as were Merge into, Reset voice, and Delete person through the overflow. Delete still opened its preview and confirmation.

## Same fixture rows, before and after

| Row              | `origin/master`                                                                                                                                                                                                                                                      | This branch                                                                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alexandra Rivera | `Alexandra Rivera alexandra@example.test` on one line; `Meetings: 10 · 10 notes · 895 segments · Last seen Oct 30, 2026`; possible duplicate; Rename, Merge into…, Delete person, Enrol voice side by side.                                                          | `Alexandra Rivera` then muted `alexandra@example.test`; `10 meetings · 10 notes · 895 segments · Last seen 30 Oct`; No voice profile chip and duplicate hint; Enrol voice plus overflow.                                                    |
| Maya Chen        | `Maya Chen maya@example.test`; `Meetings: 1 · 1 notes · 4 segments · Last seen Nov 2, 2026`; Used once and Legacy voice; `0 of 3 clean spans, 0 meeting · Provisional: suggestions only`; Rename, Merge into…, Delete person, Enrol voice, Reset voice side by side. | `Maya Chen` then muted `maya@example.test`; `1 meeting · 1 note · 4 segments · Last seen 2 Nov`; Provisional: suggestions only chip and Used once; Review spans plus overflow. Legacy voice and detailed span progress are in Show details. |

Baseline screenshots: [1440 px light](1440-light-before.png) · [412 px light](412-light-before.png).

## Final screenshots

| Width and theme | People list                 | Row expanded                        | Overflow open               | Inline rename                   | Delete confirmation             |
| --------------- | --------------------------- | ----------------------------------- | --------------------------- | ------------------------------- | ------------------------------- |
| 1440 light      | [list](1440-light-list.png) | [expanded](1440-light-expanded.png) | [menu](1440-light-menu.png) | [rename](1440-light-rename.png) | [delete](1440-light-delete.png) |
| 1440 dark       | [list](1440-dark-list.png)  | [expanded](1440-dark-expanded.png)  | [menu](1440-dark-menu.png)  | [rename](1440-dark-rename.png)  | [delete](1440-dark-delete.png)  |
| 412 light       | [list](412-light-list.png)  | [expanded](412-light-expanded.png)  | [menu](412-light-menu.png)  | [rename](412-light-rename.png)  | [delete](412-light-delete.png)  |
| 412 dark        | [list](412-dark-list.png)   | [expanded](412-dark-expanded.png)   | [menu](412-dark-menu.png)   | [rename](412-dark-rename.png)   | [delete](412-dark-delete.png)   |

The existing meeting, note, segment, last seen, and voice facts remain in the default row. Detailed span progress and the Legacy voice marker moved to Show details. Duplicate hints, Used once, reapproval, review rows, history, and the existing action preview remain reachable. Rename moved to the inline pencil; Merge into…, Reset voice, and Delete person moved to the overflow, with Delete last and visually destructive.
