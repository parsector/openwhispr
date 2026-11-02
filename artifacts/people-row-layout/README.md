# People row layout verification

The People screen was rendered in Chromium with the app's CSS, translations, and shared components. A 20-person fixture covers duplicates, no voice, provisional voice, and graduated voice. The interaction design is in [DESIGN-NOTE.md](DESIGN-NOTE.md).

The first row measured **176 px at 1440 px** and **240 px at 412 px** in both themes. After opening Delete and pressing Cancel, the resting row returned to the same text and height: **0 px delta** in all four cases. The scroll offset stayed **455 → 455 px** at 1440 px and **827 → 827 px** at 412 px while opening Delete on the first row; that row remained visible. The warning was a descendant of that row. Focus moved to Cancel and returned to the `⋯` trigger after Cancel. The trigger reported `aria-expanded="true"` while its shared menu was open. No page errors occurred.

| Width and theme | List                        | Details expanded                    | `⋯` menu                    | Delete in row                   | Merge in row                  | Rename in place                 | After Cancel                        |
| --------------- | --------------------------- | ----------------------------------- | --------------------------- | ------------------------------- | ----------------------------- | ------------------------------- | ----------------------------------- |
| 1440 light      | [list](1440-light-list.png) | [expanded](1440-light-expanded.png) | [menu](1440-light-menu.png) | [delete](1440-light-delete.png) | [merge](1440-light-merge.png) | [rename](1440-light-rename.png) | [restored](1440-light-restored.png) |
| 1440 dark       | [list](1440-dark-list.png)  | [expanded](1440-dark-expanded.png)  | [menu](1440-dark-menu.png)  | [delete](1440-dark-delete.png)  | [merge](1440-dark-merge.png)  | [rename](1440-dark-rename.png)  | [restored](1440-dark-restored.png)  |
| 412 light       | [list](412-light-list.png)  | [expanded](412-light-expanded.png)  | [menu](412-light-menu.png)  | [delete](412-light-delete.png)  | [merge](412-light-merge.png)  | [rename](412-light-rename.png)  | [restored](412-light-restored.png)  |
| 412 dark        | [list](412-dark-list.png)   | [expanded](412-dark-expanded.png)   | [menu](412-dark-menu.png)   | [delete](412-dark-delete.png)   | [merge](412-dark-merge.png)   | [rename](412-dark-rename.png)   | [restored](412-dark-restored.png)   |

[Machine-readable measurements](metrics.json). The prior branch's light baseline captures are retained as [1440 px](1440-light-before.png) and [412 px](412-light-before.png).

The separate interaction proof is `node --test test/browser/peopleRowActions.cjs`. It mounts the committed 20-person fixture, checks the row descendant, preview fields, Tab loop, Escape, Cancel restoration, focus, scroll, merge selection, one-open-row rule, rename by Enter, and reset voice.
