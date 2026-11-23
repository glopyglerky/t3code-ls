import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link, useLinkProps } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type FocusEventHandler, type TouchEventHandler, type MouseEventHandler } from "react";
import { loadOnboardingBindings, type ThreadLinkMount } from "../../onboarding/dioxusBindings";

type Props = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  label: string;
  className: string;
};

// Only the plain thread-read title link opts in. Rich chips and row actions keep
// their owners. No provider action or alternate selected-thread state is created.
export function SemanticThreadLink(props: Props) {
  return import.meta.env.VITE_T3_CODE_LS_THREAD_LINK_RENDERER === "dioxus"
    ? <DioxusThreadLink {...props} />
    : <RetainedThreadLink {...props} />;
}

function RetainedThreadLink({ environmentId, threadId, label, className }: Props) {
  return <Link to="/$environmentId/$threadId" params={{ environmentId, threadId }} className={className}>{label}</Link>;
}

export function DioxusThreadLink(props: Props) {
  const { environmentId, threadId, label, className } = props;
  const container = useRef<HTMLSpanElement>(null);
  const host = useRef<HTMLSpanElement>(null);
  const mount = useRef<ThreadLinkMount | undefined>(undefined);
  const [anchor, setAnchor] = useState<HTMLAnchorElement | null>(null);
  // Reuse Link's modifier/default-prevented checks, preload and guarded router
  // dispatch. This bounded link has no target, download, style or custom handlers.
  const link = useLinkProps({ to: "/$environmentId/$threadId", params: { environmentId, threadId }, className });
  const attributes = link as typeof link & { "data-status"?: string; "data-transitioning"?: string };
  const href = link.href ?? "";
  const currentHref = useRef(href);
  currentHref.current = href;
  const attach = useEffectEvent((bindings: Awaited<ReturnType<typeof loadOnboardingBindings>>, root: HTMLSpanElement) => {
    mount.current = bindings.mount_thread_link(root, href, label, link.className ?? className);
  });
  const focusOnCommit = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- commit the external renderer's real anchor, with a bounded retained fallback
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    let disposed = false;
    const observer = new MutationObserver(() => {
      const next = root.querySelector<HTMLAnchorElement>('a[data-thread-link-renderer="dioxus-wasm"]');
      if (!next) return;
      observer.disconnect();
      window.clearTimeout(deadline);
      focusOnCommit.current = container.current?.contains(document.activeElement) ?? false;
      setAnchor(next);
    });
    const dispose = () => {
      disposed = true;
      observer.disconnect();
      window.clearTimeout(deadline);
      mount.current?.free();
      mount.current = undefined;
    };
    const deadline = window.setTimeout(dispose, 15_000);
    observer.observe(root, { childList: true, subtree: true });
    void loadOnboardingBindings().then((bindings) => {
      if (!disposed) attach(bindings, root);
    }).catch(dispose);
    return dispose;
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- preserve the native anchor and focused DOM identity across title and destination updates
  useLayoutEffect(() => {
    mount.current?.update(href, label, link.className ?? className);
  }, [href, label, link.className, className]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attach the router's real anchor ref for viewport preload and mirror its accessibility/transition attributes
  useLayoutEffect(() => {
    if (!anchor) return;
    const ref = link.ref;
    const cleanup = typeof ref === "function" ? ref(anchor) : undefined;
    if (ref && typeof ref !== "function") ref.current = anchor;
    for (const name of ["aria-current", "data-status", "data-transitioning"] as const) {
      const value = attributes[name];
      if (value == null) anchor.removeAttribute(name);
      else anchor.setAttribute(name, String(value));
    }
    if (focusOnCommit.current) {
      focusOnCommit.current = false;
      anchor.focus({ preventScroll: true });
    }
    return () => {
      if (typeof cleanup === "function") cleanup();
      else if (typeof ref === "function") ref(null);
      else if (ref) ref.current = null;
    };
  }, [anchor, link.ref, link["aria-current"], attributes["data-status"], attributes["data-transitioning"]]);
  // Link's public handlers use getAttribute on currentTarget. A target-less span
  // is equivalent for this restricted link; the native anchor retains href,
  // keyboard activation and browser modifier/context-menu behavior.
  const onClick: MouseEventHandler<HTMLSpanElement> = (event) => {
    if (!anchor || !(event.target instanceof Node) || !anchor.contains(event.target)) return;
    // Never dispatch a new destination while the asynchronous renderer shows an old href.
    if (anchor.getAttribute("href") !== currentHref.current) {
      event.preventDefault();
      return;
    }
    (link.onClick as MouseEventHandler<HTMLSpanElement> | undefined)?.(event);
  };
  return <span ref={container} className="contents" onClick={onClick}
    onFocus={anchor ? link.onFocus as FocusEventHandler<HTMLSpanElement> : undefined}
    onMouseEnter={anchor ? link.onMouseEnter as MouseEventHandler<HTMLSpanElement> : undefined}
    onMouseLeave={anchor ? link.onMouseLeave as MouseEventHandler<HTMLSpanElement> : undefined}
    onTouchStart={anchor ? link.onTouchStart as TouchEventHandler<HTMLSpanElement> : undefined}>
    <span ref={host} style={{ display: anchor === null ? "none" : "contents" }} />
    {anchor === null && <RetainedThreadLink {...props} />}
  </span>;
}
