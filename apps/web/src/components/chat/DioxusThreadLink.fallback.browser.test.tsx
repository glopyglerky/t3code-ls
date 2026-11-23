import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
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
