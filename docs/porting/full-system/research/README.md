# Research and implementation evidence

This directory preserves the full source research used by the [architecture](../ARCHITECTURE.md) and [implementation plan](../IMPLEMENTATION.md). Research baseline is `pingdotgg/t3code@28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`.

| Directory | Contents |
|---|---|
| [server](server/server-capabilities.md) | 27 capability families, all 247 declared RPCs, HTTP/MCP inventories, provider protocols and coverage |
| [clients](clients/client-platform-review.md) | 30 client/platform families, CLI contracts and journeys 34-60 |
| [rust-stack](rust-stack/RUST-STACK-RESEARCH.md) | UI, terminal, Git, search, text, transport and platform implementation research with exact source pins |
| [database](database/report.md) | Persistence operation maps, layout/engine analysis, history design critique and journeys 1-33 |

[Research coverage](../RESEARCH-COVERAGE.md) distinguishes inventory, source capture, semantic review and missing qualification. [The manifest](manifest.json) hashes the sanitized research files in this directory. Raw repository source dumps and full PR bodies are omitted; source links and Git blob identities retain provenance.

These are research records, not implementation acceptance receipts. The database study predates the broader system design and is subordinate to it. Historical benchmark results retain their original fixture and scope limits. No source count, architecture or dependency selection establishes a measured t3code-ls win.

Operator paths and retrieval-host identifiers were removed for public publication. Source code identities, primary links, reviewed findings and coverage limits are retained. Dependency pins are research observations, not changes to the application's dependency locks.
