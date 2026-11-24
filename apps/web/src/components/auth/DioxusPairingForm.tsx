import { startTransition, useEffect, useEffectEvent, useRef, useState } from "react";

import { peekPairingTokenFromUrl, stripPairingTokenFromUrl } from "../../environments/primary";
import { loadOnboardingBindings, type DioxusMount } from "../../onboarding/dioxusBindings";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";

export function DioxusPairingForm({
  initialErrorMessage,
  submitCredential,
  onAuthenticated,
  onUseStandardPairing,
}: {
  initialErrorMessage: string;
  submitCredential: (credential: string) => Promise<string | null>;
  onAuthenticated: () => void;
  onUseStandardPairing: () => void;
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
    let mount: DioxusMount | undefined;
    void loadOnboardingBindings()
      .then((bindings) => {
        if (disposed) return;
        const token = peekPairingTokenFromUrl() ?? "";
        mount = bindings.mount_pairing_form(
          root,
          token,
          readInitialError(),
          submitCredential,
          () => {
            if (!disposed) completePairing();
          },
        );
        if (token) stripPairingTokenFromUrl();
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
          <Button size="sm" onClick={onUseStandardPairing}>
            Use standard pairing
          </Button>
        </div>
      )}
    </>
  );
}
