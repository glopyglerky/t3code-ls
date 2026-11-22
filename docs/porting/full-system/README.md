# Full-system Rust implementation guide

Build one complete T3 Code product whose application implementation becomes Rust and whose user workflows outperform stock upstream. Preserve desktop, browser, mobile, CLI, environment services, every provider, workspace tools, automation, remote access, hosted services and distribution/recovery. The database is one part of that product.

This guide turns the complete research into implementation work. It does not promote any port or choose an unqualified engine/toolkit for production. Live implementation and platform states remain in [port-map.json](../../../port-map.json).

## Start here

1. Read [current state](CURRENT-STATE.md) and the current repository [instructions](../../../AGENTS.md). Refresh the existing porting queue and relevant active work before editing.
2. Read [architecture](ARCHITECTURE.md) for the complete system and the reasons behind the proposed design.
3. Select a dependency-ready work package in [implementation](IMPLEMENTATION.md). Its static [work-package definitions](work-packages.json) describe scope and evidence, not mutable completion status.
4. Follow [the first end-to-end slice](FIRST-SLICE.md) for the initial conversation/history implementation.
5. Use [acceptance](ACCEPTANCE.md) and the [journey mapping](journeys.json) to define the comparison and failure cases before implementation.
6. Give the next worker [the agent handoff](AGENT-HANDOFF.md), the selected package and the exact source/qualification identity.

## Source and comparison identities

| Identity | Value | Meaning |
|---|---|---|
| Fork audited for implementation ownership | `3577878a5e008c8af87a8fbdae13d26dea1c2f50` | Starting source snapshot for this plan |
| Fork's integrated upstream | `c7a3f02e3851923ced8ebd000db79f641e11b038` | Current source integration in the committed lock at the audit |
| Research and performance baseline | `28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f` | Stock upstream studied for this full-system design |
| Newer upstream observed at publication | `a3323d4a433a1a4d074e402083df15c63db1a32c` | Detection only; not integrated or semantically reviewed here |

The existing fork is the implementation starting point. Stock upstream is the performance denominator. A controlled upstream-selected fork run can isolate a variable, but cannot replace the stock denominator. The research baseline does not silently advance [upstream.lock.json](../../../upstream.lock.json). Reconcile newer upstream source through the existing planner and retain exact comparison identities.

## Architecture decisions to carry forward

| Concern | Direction | Acceptance requirement |
|---|---|---|
| Shared behavior | Rust domain/contracts, client state, text and connection logic | One owner per decision, equivalent behavior and versioned boundaries |
| Environment execution | Rust orchestration and effect owners with concurrent preparation/reads and ordered commits | Atomic state/receipts/outbox, bounded queues, cancellation and unknown-outcome recovery |
| Streaming and history | Incremental representations from provider through durable event/outbox, transport, state and presentation | Replacements, pruning/replay, nested forks, exact search and stable anchors remain correct |
| Desktop | GPUI performance candidate; Makepad comparison with the same Rust core | Input, accessibility, browser composition, frames, startup and lifecycle |
| Browser | Dioxus/WASM with semantic DOM | Complete browser interaction, navigation, accessibility, offline and download/startup costs |
| Mobile | Makepad first native candidate plus remaining platform integration | Native IME, lifecycle, secure keys, media, notifications, extensions and distribution |
| Storage | omdb remains the authoritative domain/store boundary; compare transactional Fjall and direct redb using the same operations | Equal durability, full workload, maintenance, migration, backup and recovery |
| Experimental control | Same Rust server with SQLite in independent fixture state | Separate architecture effects from engine effects; never reopen an activated native home through SQLite |
| Remote | Native iroh routes, required HTTP/browser compatibility and complete Rust Connect services | Pairing, account/grant lifecycle, direct/relay behavior and all clients |
| Workspace and providers | Port actual execution, protocols and client behavior in existing owners | Git/search/PTYS, every provider's capabilities, MCP, automation, previews, devices and media |

These are research-backed candidates. A different qualified choice may replace a candidate through a recorded decision and the same complete acceptance criteria. Toolkit selection never removes a product capability.

## What is authoritative

| Record | Owns |
|---|---|
| [AGENTS.md](../../../AGENTS.md) | Repository work, source retention, compiler and publication constraints |
| [port-map.json](../../../port-map.json) | Actual Rust owners, consumers, target routes, state and acceptance/retirement evidence |
| [upstream.lock.json](../../../upstream.lock.json) | Detected, integrated and qualified source identities |
| [toolchain.lock.json](../../../toolchain.lock.json), [lust-toolchain.json](../../../lust-toolchain.json) | Packaged compiler route and separate native Lust subset identity |
| [Existing CI and porting](../../ci-and-porting.md) | Executable selection, source guards, exact-source receipts and generated upstream work queue |
| This directory | Prospective complete architecture, work decomposition, acceptance requirements and research |

The work-package IDs organize design and delegation. They do not replace port-map states or create another live progress register. An implementation PR must update existing ownership/evidence records and add a mapped owner for previously unmapped runtime behavior.

## Completion rule

A capability is complete only when the real application reaches the intended Rust owner through its normal entry point, preserves the required user outcome and failure/recovery behavior, and passes the affected platform and performance gates. Retained upstream clients remain available until their Rust replacements satisfy those gates. Passing a backend flow through a retained client does not qualify a Rust client.

The initial source audit records eight integrated ports, two candidates and no accepted/retired/synced ports. Its platform acceptance objects are empty. That is a pinned accounting observation, not a denial of earlier component results. This documentation change creates no new execution result or measured speedup.

## Research available in the repository

The [research index](research/README.md) includes server and provider capabilities, every declared RPC assignment, client/platform capabilities, CLI contracts, engine and layout comparisons, source pins, historical speedup evidence and the complete two-part 60-journey matrix. [Coverage](RESEARCH-COVERAGE.md) states what was actually reviewed and what remains unverified.

Keep research source identities and reviewed limitations when continuing. Historical optimization ratios are not new Rust performance results, and optimizations already in the stock baseline cannot be counted again.
