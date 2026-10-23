# Fork rebase map

Base: `integration/local-mcp` (from upstream `main`). Keep the changes below in separate branches when rebasing.

| Branch | Change | Upstream path |
| --- | --- | --- |
| `fix/model-capability-predicate` | Correct the model capability predicate. | Upstreamable |
| `feat/mcp-notes-server`, `feat/mcp-client` → `integration/local-mcp` | Add the local MCP notes server and client. | Upstreamable |
| `privacy/no-telemetry` | Remove telemetry and analytics; harden local logs. | Fork only |
| `privacy/no-upsell` | Remove commerce UI, checkout and upgrade entry points while retaining entitlement gates. | Fork only |

The two privacy branches are independent changes based on `integration/local-mcp`; combine them only in a downstream fork branch.
