import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { DioxusThreadLink } from "./DioxusThreadLink";

// Uses the produced binding and actual router, without mocking native DOM.
it("keeps native href, focus, prevented/modifier activation, history and remount semantics", async () => {
  const row = (label = "Read synthetic thread") => <>
    <input aria-label="Synthetic composer" defaultValue="Unsent 雪 draft" />
    <DioxusThreadLink environmentId={EnvironmentId.make("synthetic-environment")}
      threadId={ThreadId.make("synthetic-thread")} label={label} className="focus-visible:outline-2" />
  </>;
  await using screen = await render(row());
  screen.container.querySelector("a")?.focus();
  const native = () => screen.container.querySelector<HTMLAnchorElement>('[data-thread-link-renderer="dioxus-wasm"]');
  await vi.waitFor(() => expect(native()?.getAttribute("href")).toBe("/synthetic-environment/synthetic-thread"));
  const anchor = native()!;
  expect(document.activeElement).toBe(anchor);
  anchor.focus();
  await screen.rerender(row("Renamed 雪 thread"));
  await vi.waitFor(() => expect(native()?.textContent).toBe("Renamed 雪 thread"));
  expect(native()).toBe(anchor);
  expect(document.activeElement).toBe(anchor);
  // Cancel at the document to avoid opening real tabs in the test runner. The
  // candidate must leave modified activations uncancelled until this listener.
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
    let candidatePrevented = true;
    const cancelBrowser = (event: MouseEvent) => {
      candidatePrevented = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", cancelBrowser, { once: true });
    await act(() => anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers })));
    expect(candidatePrevented).toBe(false);
    expect(screen.router?.state.location.pathname).toBe("/");
  }
  const prevented = new MouseEvent("click", { bubbles: true, cancelable: true });
  prevented.preventDefault();
  await act(() => anchor.dispatchEvent(prevented));
  expect(screen.router?.state.location.pathname).toBe("/");
  await screen.getByRole("link", { name: "Renamed 雪 thread" }).click();
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/synthetic-environment/synthetic-thread"));
  await act(() => screen.router?.history.back());
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/"));
  expect(screen.container.querySelector("input")?.value).toBe("Unsent 雪 draft");
  await screen.rerender(<p>Closed</p>);
  expect(anchor.isConnected).toBe(false);
  await screen.rerender(row());
  await vi.waitFor(() => expect(native()?.textContent).toBe("Read synthetic thread"));
  expect(native()).not.toBe(anchor);
});
