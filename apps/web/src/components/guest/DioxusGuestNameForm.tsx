import { useEffect, useEffectEvent, useRef, useState } from "react";
import { loadOnboardingBindings, type GuestNameMount } from "../../onboarding/dioxusBindings";
import { Button } from "../ui/button";

/** Only form data and status cross this UI boundary; GuestPage retains the invite. */
export function DioxusGuestNameForm({ name, pending, error, submit, useStandard }: {
  name: string;
  pending: boolean;
  error: string | null;
  submit: (name: string) => void;
  useStandard: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const mount = useRef<GuestNameMount | undefined>(undefined);
  const [status, setStatus] = useState<"loading" | "mounted" | "error">("loading");
  const readState = useEffectEvent(() => ({ name, pending, error }));
  const onSubmit = useEffectEvent(submit);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- own and dispose the external Wasm form on guest route exit
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    let disposed = false;
    void loadOnboardingBindings().then((bindings) => {
      if (disposed) return;
      const state = readState();
      mount.current = bindings.mount_guest_name(root, state.name, state.pending, state.error ?? "",
        (value) => { if (!disposed) onSubmit(value); });
      setStatus("mounted");
    }).catch(() => { if (!disposed) setStatus("error"); });
    return () => { disposed = true; mount.current?.free(); mount.current = undefined; };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- update committed request status without replacing the external focused input
  useEffect(() => { mount.current?.update(pending, error ?? ""); }, [pending, error]);
  return <>
    <div ref={host} className="contents" />
    {status === "loading" && <p role="status" className="m-auto p-6 text-sm text-muted-foreground">Loading the name form…</p>}
    {status === "error" && <div className="m-auto max-w-xs space-y-3 p-6">
      <p role="alert">Could not open the guest name form.</p>
      <Button onClick={useStandard}>Use standard form</Button>
    </div>}
  </>;
}
