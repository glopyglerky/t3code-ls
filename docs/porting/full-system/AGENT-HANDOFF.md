# Implementation agent handoff

## Assignment

Continue the complete Rust implementation of t3code-ls through one dependency-ready work package in [IMPLEMENTATION.md](IMPLEMENTATION.md). Preserve all upstream user capabilities. Establish improvement against pinned stock upstream using complete user journeys. The existing fork is the starting implementation, not the benchmark denominator.

Read [README](README.md), [current state](CURRENT-STATE.md), [architecture](ARCHITECTURE.md), [acceptance](ACCEPTANCE.md) and the selected package before editing. The [first-slice specification](FIRST-SLICE.md) defines the initial conversation/history proof. Detailed source research is retained in [research](research/README.md).

## Refresh before work

1. Read current repository instructions and the selected subtree's instructions, if any.
2. Record current branch, commit/tree, active owners and relevant open PRs. Preserve unrelated work. Documentation snapshot states are not current runtime evidence.
3. Read `port-map.json`, `upstream.lock.json`, compiler locks and existing qualification records. Generate the current upstream and CI plans through their existing tools.
4. Reconcile integrated upstream, the selected comparison source and any newer detected source. Keep detected, integrated and qualified revisions separate.
5. Confirm the selected package's prerequisites and real production caller. An unmapped capability requires a recorded owner; a component demo does not create a production integration.

## Bound the assignment

Use this template in the implementation PR or worker assignment. Fill every field with real source facts or an explicit proposed output.

```text
Work package and user journey:
Source commit/tree and upstream comparison identity:
Existing port IDs and application owner:
Owned source paths and production entry/caller:
Shared interfaces that require coordination:
Required upstream behavior, errors and invariants:
Inputs, fixture identities and platform targets:
Implementation increment and proposed new paths:
Durable state, transaction and external-effect owner:
Migration/activation and rollback boundary:
Cancellation, unknown outcomes, cleanup and negative cases:
Selected build/contract/platform/performance gates:
Predeclared budgets and benchmark controls:
Evidence destination and required receipt identities:
Out-of-scope packages and retained implementations:
Next owner/action after this increment:
```

Assign distinct files and explicit shared-interface ownership to parallel workers. Coordinate changes to schema, event formats, shared contracts, toolchain and CI policy before parallel implementations depend on them. The runtime and qualification owners in the existing map remain authoritative; work-package IDs do not grant execution or publication authority.

## Implementation rules

- Extend the actual server/client/domain owners. Reuse preserved Rust components without turning the standalone native API into a second product.
- Select implementation before effects. Never retry an uncertain provider call or mutation through another backend.
- Keep omdb authoritative for the native application. A SQLite experimental control uses independent fixture state and is not a production fallback.
- Keep the same required semantics across engine candidates. Include background maintenance, durability, migration and recovery in comparisons.
- Preserve working original clients and platform code until their own Rust replacements pass the affected gates. A retained-client integration test is not Rust-client acceptance.
- Distinguish Rust application code, generated/toolkit glue, unsafe/FFI/native dependencies, browser hosts and external providers. Do not claim whole-stack memory safety from a Rust binding.
- Follow the pinned Lustr/BlueFe route and matching produced sysroot. Keep native Lust subset evidence separate. Do not rebuild the compiler or substitute unmatched drivers as a routine app step.
- Use isolated controlled state and provider fixtures. Do not use installed application databases, personal credentials or live provider turns for routine qualification.
- Keep public repository content generic. Preserve licenses and provenance. Do not publish operator environment, credentials or private project composition.

## Acceptance records

Use the repository's existing port-map and qualification receipts. Keep candidate, integrated, accepted, retired and synced distinct. The work-package JSON is a static design and dependency definition; do not turn it into another mutable status tracker.

Every result names the source/tree, actual built artifact, compiler route, dependency locks, target/platform, fixture/input, command or workflow/job, selection and assertion, and outcome. Preserve failed/cancelled/skipped attempts and actual cleanup. An authored test or passing donor regression does not establish observed production execution.

If changing the storage execution boundary, prove selection and execution of the real native client flow. Review the current `PRODUCTION_PORTS` selection and `omdb` route-label acceptance gap described in [current state](CURRENT-STATE.md). Do not weaken the gate or relabel the engine merely to make accounting pass.

## Before publishing a continuation

Review the diff for owned scope, source retention, private content and unsupported claims. Run the generated affected gates. Keep raw generated build data outside canonical source. Link concise exact-source evidence from the existing records; keep the current failure and next action visible.

Carry the repository's mandatory external GitHub attribution rule into every worker handoff. For an authorized submission outside the verified `glopyglerky` and `omnidia-dev` namespaces, verify exact author models, roles and the actual harness chain, distinguish reviewers, and append the visible footer at the end of the submission body or commit message. Classify a PR by its base repository. Do not infer historical authorship or invent missing provenance; retain a private draft if provenance cannot be verified. Exclude private paths, thread identifiers, transcripts and credentials. This rule does not authorize publication.

```md
---
**AI attribution**
- Models: <verified exact models and roles>
- Harness: <verified actual harness chain>
```

Publish implementation through the authorized branch/PR route and verify the published head and changed content. Never infer CI execution from a PR's existence; the workflow's actual triggers and run identity control. Do not merge, deploy or change visibility without authorization.

The continuation summary must say what changed in the real application, which outcomes were observed, what remains incomplete, the current comparison result, and the exact next package/owner. A complete research plan is the starting specification, not proof of a complete Rust product.
