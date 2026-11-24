import { useEffect, useEffectEvent, useRef, useState } from "react";

import { loadOnboardingBindings, type WelcomeMount } from "../../onboarding/dioxusBindings";
import { Button } from "../ui/button";

export function DioxusWelcomeControls({
  agentReady,
  isImporting,
  selectedCount,
  newCount,
  onStart,
  onUseStandardSetup,
}: {
  agentReady: boolean;
  isImporting: boolean;
  selectedCount: number;
  newCount: number;
  onStart: () => void;
  onUseStandardSetup: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const mount = useRef<WelcomeMount | undefined>(undefined);
  const [status, setStatus] = useState<"loading" | "mounted" | "error">("loading");
  const readState = useEffectEvent(() => ({ agentReady, isImporting, selectedCount, newCount }));
  const start = useEffectEvent(onStart);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- own the external DOM renderer and release it before the welcome page leaves
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    let disposed = false;
    void loadOnboardingBindings().then((bindings) => {
      if (disposed) return;
      const state = readState();
      mount.current = bindings.mount_welcome_controls(
        root, state.agentReady, state.isImporting, state.selectedCount, state.newCount,
        () => { if (!disposed) start(); },
      );
      setStatus("mounted");
    }).catch(() => {
      if (!disposed) setStatus("error");
    });
    return () => {
      disposed = true;
      mount.current?.free();
      mount.current = undefined;
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pass committed application facts to the existing Rust mount without replacing focused controls
  useEffect(() => {
    mount.current?.update(agentReady, isImporting, selectedCount, newCount);
  }, [agentReady, isImporting, selectedCount, newCount]);

  return (
    <>
      <div ref={host} />
      {status === "loading" && <p className="mt-6 text-sm text-muted-foreground" role="status">Loading setup controls…</p>}
      {status === "error" && (
        <div className="mt-6 space-y-3">
          <p className="text-sm text-destructive" role="alert">Could not open setup controls.</p>
          <Button onClick={onUseStandardSetup}>Use standard setup</Button>
        </div>
      )}
    </>
  );
}
