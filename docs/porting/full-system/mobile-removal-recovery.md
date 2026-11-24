# Mobile environment removal recovery

The mobile connection catalog records pending data cleanup in its existing SecureStore document. One catalog write removes the environment's targets, credentials, profiles, tokens, routes and grants, and reserves a removal sequence. A failed write leaves the registered connection intact. The registry retains its existing sibling cleanup and SSH disconnect behavior.

Mobile storage construction retries pending removals before exposing the catalog to the registry. Cleanup failure retains the reservation and the absent target. Reconnecting that environment first retries cleanup and refuses registration while the reservation remains. The catalog lock covers data deletion and registration, so a new link cannot install while an older cleanup is deleting its data. Completion requires the original environment and sequence. A linked target prevents stale cleanup from deleting its data.

Outbox, drafts and composer errors stay with their current owners. Repeated deletion is idempotent. If the process stops after data deletion but before recording completion, reopening repeats deletion. The completion write and cached catalog publication are protected from fiber interruption. No separate journal or progress store is added.

The unit fixture uses the real mobile catalog and storage layer with disposable SecureStore and owned-data adapters. It covers failed cleanup followed by fresh instances, blocked and successful relink, unrelated environment data, failed credential removal writes, concurrent relink, and stale sequence/target guards. The shared catalog fixture checks JSON round trips and unrelated edits. The existing registry tests qualify registry cleanup and disconnect behavior separately. Run the existing client recovery workflow's cleanup lane to execute these fixtures together.

This slice is unqualified until that hosted run passes. Native iOS and Android process termination and SecureStore durability still need platform evidence. It assumes one mobile catalog owner. It does not reconstruct failed removals from older versions that stored no reservation. The existing corrupt-catalog discard policy and older clients that discard the optional field remain compatibility gaps. This is a TypeScript adapter increment; it does not establish a native Rust mobile client.

Stock comparison remains `28706aceb6fb3babf2cbae0dc0c3edd93b9b6d5f`. The mandatory method SHA-256 is `5744f9bc85c2fb61d01bba3434f200312efce584b1d2cbbd73f7a42219a3dd30`. Existing MIT provenance is retained.
