import { initSync, fold_savings } from "@t3tools/task-cache/native-savings-glue";
import module from "@t3tools/task-cache/native-savings-wasm";
import * as Savings from "./Savings.ts";
import * as SavingsFold from "./SavingsFold.ts";

// Workers supplies a precompiled module. The generated web binding owns imports.
initSync({ module });
export const layer = Savings.layerWithFold(SavingsFold.fromWasm({ fold_savings }));
