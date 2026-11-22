import type { RichDocMap, RichRun } from "./composer-rich-text-doc";

interface NativeMap {
  flat_to_markdown(offset: number): number;
  markdown_to_flat(offset: number): number;
  flat_to_prose_mirror(offset: number): number;
  prose_mirror_to_flat(position: number): number;
}

interface OffsetModule {
  default(): Promise<unknown>;
  ComposerOffsetMap: { from_words(words: Uint32Array, length: number): NativeMap | undefined };
}

const runKinds = { text: 0, token: 2, break: 3, prefix: 4 } satisfies Record<RichRun["kind"], number>;
const maps = new WeakMap<RichDocMap, NativeMap>();
let offsetModule: OffsetModule | undefined;
let recordedUse = false;

export async function initializeComposerOffsets(): Promise<void> {
  if (import.meta.env.VITE_T3_CODE_LS_COMPOSER_OFFSETS !== "rust") return;
  const url = new URL(
    `${import.meta.env.BASE_URL}client-text-wasm/composer_offsets.js`,
    window.location.origin,
  );
  const module: OffsetModule = await import(/* @vite-ignore */ url.href);
  await module.default();
  offsetModule = module;
}

export function nativeComposerOffsetMap(map: RichDocMap): NativeMap | undefined {
  if (offsetModule === undefined) return undefined;
  const existing = maps.get(map);
  if (existing !== undefined) return existing;

  const words = new Uint32Array(map.runs.length * 7);
  let index = 0;
  for (const run of map.runs) {
    words[index++] = run.kind === "text" && run.nodeName === "codeBlock" ? 1 : runKinds[run.kind];
    words[index++] = run.flatStart;
    words[index++] = run.mdStart;
    words[index++] = run.docLen;
    words[index++] = run.mdLen;
    words[index++] = run.openLen;
    words[index++] = run.pmPos;
  }
  const nativeMap = offsetModule.ComposerOffsetMap.from_words(words, map.docLength);
  if (nativeMap === undefined) throw new Error("Rust composer offset map rejected editor runs");
  maps.set(map, nativeMap);
  if (!recordedUse) {
    performance.mark("t3-composer-rust-offsets");
    recordedUse = true;
  }
  return nativeMap;
}
