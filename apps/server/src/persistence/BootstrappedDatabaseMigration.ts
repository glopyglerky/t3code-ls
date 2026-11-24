import * as Context from "effect/Context";

/** Metadata earned by the selected native owner after all startup work succeeds. */
export class BootstrappedDatabaseMigration extends Context.Service<
  BootstrappedDatabaseMigration,
  { readonly databasePath: string; readonly head: number }
>()("t3/persistence/BootstrappedDatabaseMigration") {}
