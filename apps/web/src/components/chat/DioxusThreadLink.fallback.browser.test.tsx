import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { DioxusThreadLink } from "./DioxusThreadLink";

// Loader-failure component check only. Actual denied network fallback is the
// separate packaged helper and must run in a fresh synthetic browser profile.
vi.mock("../../onboarding/dioxusBindings", () => ({
  loadOnboardingBindings: () => Promise.reject(new Error("synthetic unavailable binding")),
}));
it("keeps the retained link usable when the native module cannot load", async () => {
  await using screen = await render(<DioxusThreadLink environmentId={EnvironmentId.make("synthetic")}
    threadId={ThreadId.make("target")} label="Retained target" className="underline" />);
  const link = screen.getByRole("link", { name: "Retained target" });
  await expect.element(link).toBeVisible();
  expect(screen.container.querySelector('[data-thread-link-renderer="dioxus-wasm"]')).toBeNull();
  await link.click();
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/synthetic/target"));
});

it("routes normal activation through the sidebar owner exactly once", async () => {
  const onNavigate = vi.fn();
  await using screen = await render(<DioxusThreadLink environmentId={EnvironmentId.make("synthetic")}
    threadId={ThreadId.make("owner-target")} label="Owned navigation" className="underline" onNavigate={onNavigate} />);
  const anchor = screen.container.querySelector("a")!;
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
    let candidatePrevented = true;
    const cancel = (event: MouseEvent) => { candidatePrevented = event.defaultPrevented; event.preventDefault(); };
    document.addEventListener("click", cancel, { once: true });
    await act(() => anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers })));
    expect(candidatePrevented).toBe(false);
  }
  const prevented = new MouseEvent("click", { bubbles: true, cancelable: true });
  prevented.preventDefault();
  await act(() => anchor.dispatchEvent(prevented));
  expect(onNavigate).not.toHaveBeenCalled();
  await screen.getByRole("link", { name: "Owned navigation" }).click();
  expect(onNavigate).toHaveBeenCalledTimes(1);
  expect(screen.router?.state.location.pathname).toBe("/");
});
