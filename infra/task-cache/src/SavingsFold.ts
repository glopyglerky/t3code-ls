import type { Summary } from "./Summary.ts";

export type SavingsTasks = (typeof Summary.Type)["tasks"];
export type SavingsTotals = readonly [
  localMs: number,
  remoteMs: number,
  localHits: number,
  remoteHits: number,
  executed: number,
  restoreFailures: number,
  unspecifiedMs: number,
  unspecifiedHits: number,
];
export type SavingsFold = (tasks: SavingsTasks) => SavingsTotals;

export const retained: SavingsFold = (tasks) => {
  const local = tasks.filter((task) => task.source === "local");
  const remote = tasks.filter((task) => task.source === "remote");
  const unspecified = tasks.filter((task) => task.source === "unspecified");
  return [
    local.reduce((sum, task) => sum + task.savedMs, 0),
    remote.reduce((sum, task) => sum + task.savedMs, 0),
    local.length,
    remote.length,
    tasks.filter((task) => task.source === "executed").length,
    tasks.filter((task) => task.source === "failed").length,
    unspecified.reduce((sum, task) => sum + task.savedMs, 0),
    unspecified.length,
  ];
};

export interface WasmSavings {
  readonly fold_savings: (words: Float64Array) => Float64Array;
}

const sourceCodes = { local: 0, remote: 1, unspecified: 2, executed: 3, failed: 4 } as const;

/** Bind a verified Wasm module before recording any summaries. */
export const fromWasm = (wasm: WasmSavings): SavingsFold => (tasks) => {
  if (tasks.length > 1000) throw new Error("Savings task limit exceeded");
  const words = new Float64Array(tasks.length * 2);
  tasks.forEach((task, index) => {
    words[index * 2] = sourceCodes[task.source];
    words[index * 2 + 1] = task.savedMs;
  });
  const totals = wasm.fold_savings(words);
  if (totals.length !== 8 || !totals.every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("Invalid native savings totals");
  }
  return [
    totals[0]!,
    totals[1]!,
    totals[2]!,
    totals[3]!,
    totals[4]!,
    totals[5]!,
    totals[6]!,
    totals[7]!,
  ];
};
