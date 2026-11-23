import { installThreadMessageText } from "@t3tools/client-runtime/rpc";
import type { VoiceDraftSelectionMapper } from "@t3tools/client-runtime/voice-input";
import type { RichDocMap, RichRun } from "./composer-rich-text-doc";

interface NativeMap {
  flat_to_markdown(offset: number): number;
  markdown_to_flat(offset: number): number;
  flat_to_prose_mirror(offset: number): number;
  prose_mirror_to_flat(position: number): number;
}

interface NativeMessageText {
  append(baseSequence: number, sequence: number, suffix: string): string | undefined;
  splice?(
    baseSequence: number,
    sequence: number,
    startUtf16: number,
    endUtf16: number,
    text: string,
  ): string | undefined;
  free(): void;
}

interface OffsetModule {
  default(): Promise<unknown>;
  ComposerOffsetMap: { from_words(words: Uint32Array, length: number): NativeMap | undefined };
  map_voice_draft_selection?: (
    captured: string,
    current: string,
    start: number,
    end: number,
  ) => Uint32Array;
  reconcile_composer_drafts?: (words: Uint32Array) => Uint32Array | undefined;
  ThreadMessageText?: {
    readonly prototype?: NativeMessageText;
    from_message(sequence: number, text: string, maxBytes: number): NativeMessageText | undefined;
  };
}

const runKinds = { text: 0, token: 2, break: 3, prefix: 4 } satisfies Record<RichRun["kind"], number>;
const maps = new WeakMap<RichDocMap, NativeMap>();
let offsetModule: OffsetModule | undefined;
let draftReconciler: OffsetModule["reconcile_composer_drafts"];
let recordedDraftReconciliation = false;
let recordedUse = false;
let recordedTextAppend = false;
let recordedTextSplice = false;
let recordedVoiceDraftSelection = false;

export async function initializeComposerOffsets(): Promise<void> {
  const offsets = import.meta.env.VITE_T3_CODE_LS_COMPOSER_OFFSETS === "rust";
  const drafts = import.meta.env.VITE_T3_CODE_LS_DRAFT_RECONCILIATION === "rust";
  if (!offsets && !drafts) return;
  const url = new URL(
    `${import.meta.env.BASE_URL}client-text-wasm/composer_offsets.js`,
    window.location.origin,
  );
  let module: OffsetModule;
  try {
    module = await import(/* @vite-ignore */ url.href);
    await module.default();
  } catch (cause) {
    // Draft reconciliation is pure. No write has started, so the retained
    // implementation can safely serve a browser whose Wasm is unavailable.
    if (!drafts) throw cause;
    return;
  }
  if (drafts) draftReconciler = module.reconcile_composer_drafts;
  if (!offsets) return;
  offsetModule = module;
  const textBinding = module.ThreadMessageText;
  if (textBinding !== undefined) {
    const supportsSplices = typeof textBinding.prototype?.splice === "function";
    installThreadMessageText(
      (sequence, text, maxBytes) => {
        const base = textBinding.from_message(sequence, text, maxBytes);
        if (base === undefined) return undefined;
        return {
          append(baseSequence, sequence, suffix) {
            const text = base.append(baseSequence, sequence, suffix);
            if (text !== undefined && !recordedTextAppend) {
              performance.mark("t3-thread-rust-text-append");
              recordedTextAppend = true;
            }
            return text;
          },
          splice(baseSequence, sequence, start, end, inserted) {
            const text = base.splice?.(baseSequence, sequence, start, end, inserted);
            if (text !== undefined && !recordedTextSplice) {
              performance.mark("t3-thread-rust-text-splice");
              recordedTextSplice = true;
            }
            return text;
          },
          free: () => base.free(),
        };
      },
      supportsSplices ? 2 : 1,
    );
  }
}

export function nativeVoiceDraftSelection(): VoiceDraftSelectionMapper | undefined {
  const map = offsetModule?.map_voice_draft_selection;
  if (!map) return undefined;
  return (captured, current) => {
    if (!captured.text.isWellFormed() || !current.isWellFormed()) return undefined;
    const range = map(captured.text, current, captured.selection.start, captured.selection.end);
    const [start, end] = range;
    if (start === undefined || end === undefined) return undefined;
    if (!recordedVoiceDraftSelection) {
      performance.mark("t3-voice-rust-draft-selection");
      recordedVoiceDraftSelection = true;
    }
    return { start, end };
  };
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

/** Select before serialization or storage effects; never retry a storage write here. */
export function nativeComposerDraftReconciler() {
  if (import.meta.env.VITE_T3_CODE_LS_DRAFT_RECONCILIATION !== "rust") return undefined;
  const reconcile = draftReconciler;
  if (!reconcile) return undefined;
  return (words: Uint32Array) => {
    const result = reconcile(words);
    if (words.length > 0 && result !== undefined && !recordedDraftReconciliation) {
      performance.mark("t3-composer-rust-draft-reconciliation");
      recordedDraftReconciliation = true;
    }
    return result;
  };
}
