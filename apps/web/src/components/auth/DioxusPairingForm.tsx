import { startTransition, useEffect, useEffectEvent, useRef, useState } from "react";

import { takePairingTokenFromUrl } from "../../environments/primary";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";

interface PairingMount {
  free(): void;
}

interface PairingBindings {
  default(): Promise<unknown>;
  mount_pairing_form(
    root: HTMLDivElement,
    token: string,
    initialError: string,
    submitCredential: (credential: string) => Promise<string | null>,
    onAuthenticated: () => void,
  ): PairingMount;
}

async function initializePairingBindings(): Promise<PairingBindings> {
  const url = new URL(
    `${import.meta.env.BASE_URL}pairing-wasm/local_pairing.js`,
    window.location.origin,
  );
  const bindings: PairingBindings = await import(/* @vite-ignore */ url.href);
  await bindings.default();
  return bindings;
}

let pairingBindings: Promise<PairingBindings> | undefined;

export function DioxusPairingForm({
  initialErrorMessage,
  submitCredential,
  onAuthenticated,
}: {
  initialErrorMessage: string;
  submitCredential: (credential: string) => Promise<string | null>;
  onAuthenticated: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "mounted" | "error">("loading");
  const readInitialError = useEffectEvent(() => initialErrorMessage);
  const completePairing = useEffectEvent(() => startTransition(onAuthenticated));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mount the external renderer after its Wasm module initializes and dispose it on route exit
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    let disposed = false;
    let mount: PairingMount | undefined;
    void (pairingBindings ??= initializePairingBindings())
      .then((bindings) => {
        if (disposed) return;
        mount = bindings.mount_pairing_form(
          root,
          takePairingTokenFromUrl() ?? "",
          readInitialError(),
          submitCredential,
          () => {
            if (!disposed) completePairing();
          },
        );
        setStatus("mounted");
      })
      .catch(() => {
        if (!disposed) setStatus("error");
      });
    return () => {
      disposed = true;
      mount?.free();
    };
  }, [submitCredential]);

  return (
    <>
      <div ref={host} />
      {status === "loading" && (
        <p className="mt-6 text-sm text-muted-foreground" role="status">
          Loading the pairing form…
        </p>
      )}
      {status === "error" && (
        <div className="mt-6 space-y-4">
          <Alert variant="error">
            <AlertDescription>Could not open the pairing form.</AlertDescription>
          </Alert>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>
      )}
    </>
  );
}
