# Fork rebase map

Base: `integration/local-mcp` (from upstream `main`). Keep the changes below in separate branches when rebasing.

| Branch | Change | Upstream path |
| --- | --- | --- |
| `fix/model-capability-predicate` | Correct the model capability predicate. | Upstreamable |
| `feat/mcp-notes-server`, `feat/mcp-client` → `integration/local-mcp` | Add the local MCP notes server and client. | Upstreamable |
| `privacy/no-telemetry` | Remove telemetry and analytics; harden local logs. | Fork only |
| `privacy/no-upsell` | Remove commerce UI, checkout and upgrade entry points while retaining entitlement gates. | Fork only |

`integration/local-mcp-privacy` combines `privacy/no-telemetry` and `privacy/no-upsell` on top of `integration/local-mcp` for the downstream fork build. Keep the two privacy branches separate when rebasing, then merge both into this integration branch.
