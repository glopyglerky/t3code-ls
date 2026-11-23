import { GUEST_NAME_MAX_LENGTH } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { act, render } from "../../../test/render";
import { loadOnboardingBindings } from "../../onboarding/dioxusBindings";
import { NameForm } from "./GuestPage";

vi.mock("../../onboarding/dioxusBindings", { spy: true });
const native = import.meta.env.VITE_T3_CODE_LS_GUEST_NAME_RENDERER === "dioxus";
const originalFetch = window.fetch.bind(window);

function redemption(response: Promise<Response>) {
  return vi.spyOn(window, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    return url.pathname.endsWith("/api/guest/redeem") ? response : originalFetch(input, init);
  });
}

describe("guest name form renderer", () => {
  it("keeps semantic limits, keyboard focus, trim and exactly one pending redemption", async () => {
    const request = Promise.withResolvers<Response>();
    using fetch = redemption(request.promise);
    const joined = vi.fn();
    await using screen = await render(<NameForm credential="synthetic.invite" onJoined={joined} />);
    const input = screen.getByRole("textbox", { name: "Your name" });
    await expect.element(input).toBeVisible();
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.container.querySelector("input")));
    expect(screen.container.querySelector("input")!.maxLength).toBe(GUEST_NAME_MAX_LENGTH);
    expect(screen.container.querySelector("form")!.dataset.guestNameRenderer).toBe(native ? "dioxus-wasm" : "retained");
    await userEvent.type(input, "  Sam🦊  ");
    await act(async () => {
      const form = screen.container.querySelector("form")!;
      form.requestSubmit(); form.requestSubmit();
    });
    const posts = fetch.mock.calls.filter(([url]) => String(url).endsWith("/api/guest/redeem"));
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]![1]!.body))).toEqual({ credential: "synthetic.invite", name: "Sam🦊" });
    await expect.element(screen.getByRole("button", { name: "Join", exact: true })).toBeDisabled();
    expect(joined).not.toHaveBeenCalled();
    request.resolve(new Response(null, { status: 204 }));
    await vi.waitFor(() => expect(joined).toHaveBeenCalledTimes(1));
  });

  it("ignores a completed redemption after route disposal and detaches the old form", async () => {
    const request = Promise.withResolvers<Response>();
    using fetch = redemption(request.promise);
    const joined = vi.fn();
    await using screen = await render(<NameForm credential="synthetic.invite" onJoined={joined} />);
    const input = screen.getByRole("textbox", { name: "Your name" });
    await expect.element(input).toBeVisible();
    await userEvent.type(input, "Sam");
    const form = screen.container.querySelector("form")!;
    await act(async () => form.requestSubmit());
    await screen.unmount();
    await act(async () => { request.resolve(new Response(null, { status: 204 })); await request.promise; });
    expect(joined).not.toHaveBeenCalled();
    const count = fetch.mock.calls.length;
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(fetch.mock.calls).toHaveLength(count);
    expect(form.isConnected).toBe(false);
  });

  it.skipIf(!native)("offers retained controls when the selected module cannot initialize", async () => {
    vi.mocked(loadOnboardingBindings).mockRejectedValueOnce(new Error("Synthetic Wasm loss"));
    await using screen = await render(<NameForm credential="synthetic.invite" onJoined={vi.fn()} />);
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Could not open the guest name form.");
    await userEvent.click(screen.getByRole("button", { name: "Use standard form" }));
    await expect.element(screen.getByRole("textbox", { name: "Your name" })).toBeVisible();
    expect(screen.container.querySelector("form")!.dataset.guestNameRenderer).toBe("retained");
  });

  it.skipIf(!native)("does not mount a late Wasm result after the guest form leaves", async () => {
    const bindings = await loadOnboardingBindings();
    const load = Promise.withResolvers<typeof bindings>();
    const mount = vi.fn(bindings.mount_guest_name);
    vi.mocked(loadOnboardingBindings).mockReturnValueOnce(load.promise);
    await using screen = await render(<NameForm credential="synthetic.invite" onJoined={vi.fn()} />);
    await expect.element(screen.getByRole("status")).toHaveTextContent("Loading the name form");
    await screen.unmount();
    await act(async () => { load.resolve({ ...bindings, mount_guest_name: mount }); await load.promise; });
    expect(mount).not.toHaveBeenCalled();
  });
});
