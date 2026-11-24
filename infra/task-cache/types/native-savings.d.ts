declare module "@t3tools/task-cache/native-savings-glue" {
  export function initSync(input: { module: WebAssembly.Module }): unknown;
  export function fold_savings(words: Float64Array): Float64Array;
}

declare module "@t3tools/task-cache/native-savings-wasm" {
  const module: WebAssembly.Module;
  export default module;
}
