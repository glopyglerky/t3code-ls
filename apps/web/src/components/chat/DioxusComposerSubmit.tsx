import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEventHandler,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { loadOnboardingBindings, type ComposerSubmitMount } from "../../onboarding/dioxusBindings";

type MountState =
  | { status: "loading" | "failed" }
  | { status: "ready"; button: HTMLButtonElement };

export function DioxusComposerSubmit({
  className,
  label,
  disabled,
  onPointerDown,
  useStandard,
  onUseStandard,
  standardButton,
  children,
}: {
  className: string;
  label: string;
  disabled: boolean;
  onPointerDown?: PointerEventHandler<HTMLElement>;
  useStandard: boolean;
  onUseStandard: () => void;
  standardButton: ReactNode;
  children: ReactNode;
}) {
  const container = useRef<HTMLSpanElement>(null);
  const host = useRef<HTMLSpanElement>(null);
  const mount = useRef<ComposerSubmitMount | undefined>(undefined);
  const restoreFocus = useRef(false);
  const [view, setView] = useState<MountState>({ status: "loading" });
  const attach = useEffectEvent(
    (bindings: Awaited<ReturnType<typeof loadOnboardingBindings>>, root: HTMLSpanElement) => {
      mount.current = bindings.mount_composer_submit(root, className, label, disabled);
    },
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the status reflects the external renderer and the lifetime of its DOM
  useEffect(() => {
    const root = host.current;
    if (useStandard || !root) return;
    let disposed = false;
    const observer = new MutationObserver(() => {
      const button = root.querySelector<HTMLButtonElement>(
        'button[data-composer-submit-renderer="dioxus-wasm"]',
      );
      if (!button) return;
      observer.disconnect();
      window.clearTimeout(deadline);
      setView({ status: "ready", button });
    });
    const dispose = () => {
      disposed = true;
      observer.disconnect();
      window.clearTimeout(deadline);
      mount.current?.free();
      mount.current = undefined;
    };
    const fail = () => {
      if (disposed) return;
      dispose();
      setView({ status: "failed" });
    };
    const deadline = window.setTimeout(fail, 15_000);
    observer.observe(root, { childList: true, subtree: true });
    void loadOnboardingBindings()
      .then((bindings) => {
        if (!disposed) attach(bindings, root);
      })
      .catch(fail);
    return dispose;
  }, [useStandard]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- update the existing button and keep its DOM identity
  useLayoutEffect(() => {
    mount.current?.update(className, label, disabled);
  }, [className, label, disabled]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the explicit fallback replaces the focused control
  useLayoutEffect(() => {
    if (!useStandard || !restoreFocus.current) return;
    restoreFocus.current = false;
    const target = container.current;
    (target?.querySelector<HTMLElement>("button:enabled") ?? target)?.focus({
      preventScroll: true,
    });
  }, [useStandard]);

  return (
    <span ref={container} tabIndex={-1} className="inline-flex items-center">
      {useStandard ? (
        standardButton
      ) : (
        <>
          <span
            ref={host}
            hidden={view.status !== "ready"}
            onPointerDown={onPointerDown}
            onClick={(event) => {
              // The form owns submission. Veto clicks while the DOM catches up to the owner.
              if (view.status !== "ready" || disabled) event.preventDefault();
            }}
          />
          {view.status === "ready" && createPortal(children, view.button)}
          {view.status === "loading" && (
            <span role="status" className="h-9 w-9 sm:h-8 sm:w-8">
              <span className="sr-only">Loading Send button</span>
            </span>
          )}
          {view.status === "failed" && (
            <button
              type="button"
              className="h-9 px-2 text-sm underline sm:h-8"
              onPointerDown={onPointerDown}
              onClick={(event) => {
                restoreFocus.current = document.activeElement === event.currentTarget;
                onUseStandard();
              }}
            >
              Use standard Send button
            </button>
          )}
        </>
      )}
    </span>
  );
}
