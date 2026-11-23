import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { loadOnboardingBindings, type AssistantTextMount } from "../../onboarding/dioxusBindings";

type Presentation = { text: string; sequence: string; updatedAt: string; streaming: boolean };

/** Only the text child is replaced. Citation, selection, find, metadata and commands retain their owners. */
export function DioxusAssistantText({ text, sequence, updatedAt, streaming, children }: Presentation & { children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const mount = useRef<AssistantTextMount | undefined>(undefined);
  const [committed, setCommitted] = useState<Presentation | null>(null);
  const attach = useEffectEvent((bindings: Awaited<ReturnType<typeof loadOnboardingBindings>>, root: HTMLDivElement) => {
    mount.current = bindings.mount_assistant_text(root, text, sequence, updatedAt, streaming);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observe the external renderer's committed DOM, including each streaming update
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    let disposed = false;
    const observer = new MutationObserver(() => {
      const row = root.querySelector<HTMLElement>('[data-assistant-text-renderer="dioxus-wasm"]');
      if (!row) return;
      window.clearTimeout(deadline);
      setCommitted(row.dataset.supported === "true" ? {
        text: row.dataset.sourceText ?? "",
        sequence: row.dataset.snapshotSequence ?? "",
        updatedAt: row.dataset.messageUpdatedAt ?? "",
        streaming: row.dataset.streaming === "true",
      } : null);
    });
    const dispose = () => {
      disposed = true;
      observer.disconnect();
      window.clearTimeout(deadline);
      mount.current?.free();
      mount.current = undefined;
    };
    const deadline = window.setTimeout(dispose, 15_000);
    observer.observe(root, { attributes: true, childList: true, characterData: true, subtree: true });
    void loadOnboardingBindings().then((bindings) => {
      if (!disposed) attach(bindings, root);
    }).catch(dispose);
    return dispose;
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- update the existing Dioxus tree without remounting a streaming row
  useLayoutEffect(() => {
    mount.current?.update(text, sequence, updatedAt, streaming);
  }, [text, sequence, updatedAt, streaming]);
  const ready = committed?.text === text && committed.sequence === sequence &&
    committed.updatedAt === updatedAt && committed.streaming === streaming;
  return <>
    <div ref={host} hidden={!ready} />
    {!ready && children}
  </>;
}
