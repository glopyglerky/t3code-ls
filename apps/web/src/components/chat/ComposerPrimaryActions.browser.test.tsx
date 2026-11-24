import "~/index.css";

import type { ComponentProps, MouseEvent as ReactMouseEvent } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
  useClientSettings: () => false,
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

vi.mock("../../onboarding/dioxusBindings", () => {
  function mountButton(type: "submit" | "button", name: "submit" | "stop") {
    return (root: HTMLElement, className: string, label: string, disabled: boolean) => {
      const button = document.createElement("button");
      button.type = type;
      button.setAttribute(`data-composer-${name}-renderer`, "dioxus-wasm");
      const update = (className: string, label: string, disabled: boolean) => {
        button.className = className;
        button.setAttribute("aria-label", label);
        button.disabled = disabled;
      };
      update(className, label, disabled);
      root.append(button);
      return { update, free: () => button.remove() };
    };
  }
  return {
    loadOnboardingBindings: async () => ({
      mount_composer_submit: mountButton("submit", "submit"),
      mount_composer_stop: mountButton("button", "stop"),
    }),
  };
});

import { CollapsedComposerStopAction, ComposerPrimaryActions } from "./ComposerPrimaryActions";

function setup() {
  return {
    compact: true,
    canOperateThread: true,
    pendingAction: null,
    isRunning: true,
    canInterrupt: true,
    canResume: false,
    isSendBusy: false,
    sendDisabledReason: null,
    isEnvironmentUnavailable: false,
    isPreparingWorktree: false,
    hasSendableContent: false,
    onPreviousPendingQuestion: vi.fn(),
    onInterrupt: vi.fn(),
    onResume: vi.fn(),
    onSubmitMessage: vi.fn(),
  } satisfies ComponentProps<typeof ComposerPrimaryActions>;
}

it.each(["resume", "draft", "question"] as const)(
  "keeps repeat Stop clicks from reaching the action that replaces it (%s)",
  async (mode) => {
    const props = setup();
    const submit = vi.fn();
    const pendingAction =
      mode === "question"
        ? {
            questionIndex: 0,
            isLastQuestion: true,
            canAdvance: true,
            isResponding: false,
            isComplete: true,
          }
        : null;
    const view = (overrides: Partial<ComponentProps<typeof ComposerPrimaryActions>> = {}) => (
      <form
        style={{ display: "flex", justifyContent: "flex-end", width: "400px" }}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <ComposerPrimaryActions {...props} pendingAction={pendingAction} {...overrides} />
      </form>
    );
    await using screen = await render(view());
    using _timers = fakeTimers();
    const stop = screen
      .getByRole("button", { name: "Stop generation" })
      .element() as HTMLButtonElement;
    const { x, y, width, height } = stop.getBoundingClientRect();
    const target = () =>
      document.elementFromPoint(x + width / 2, y + height / 2)?.closest("button");
    await act(() => stop.click());
    await act(() =>
      (
        screen.getByRole("button", { name: "Stopping", exact: true }).element() as HTMLButtonElement
      ).click(),
    );
    expect(screen.getByRole("button", { name: "Stopping", exact: true }).element()).toBeDisabled();
    expect(props.onInterrupt).toHaveBeenCalledTimes(1);
    await screen.rerender(
      view({
        isRunning: false,
        canInterrupt: false,
        canResume: true,
        hasSendableContent: mode === "draft",
      }),
    );
    const action = { resume: "Resume thread", draft: "Submit message", question: "Submit" }[mode];
    expect(screen.getByRole("button", { name: "Stop generation" }).query()).toBeNull();
    expect(target()).toBe(screen.getByRole("button", { name: action, exact: true }).element());
    await act(() => {
      for (let i = 0; i < 20; i++) target()?.click();
    });
    await act(() => vi.advanceTimersByTime(499));
    await act(() => target()?.click());
    expect(props.onResume).not.toHaveBeenCalled();
    expect(props.onSubmitMessage).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTime(1));
    await act(() => target()?.click());
    expect(
      { resume: props.onResume, draft: props.onSubmitMessage, question: submit }[mode],
    ).toHaveBeenCalledTimes(1);
    await screen.rerender(view());
    expect(screen.getByRole("button", { name: "Stop generation" }).element()).toBeEnabled();
  },
);

it("allows retry after ten seconds and protects a late stop", async () => {
  const props = setup();
  await using screen = await render(<ComposerPrimaryActions {...props} />);
  using _timers = fakeTimers();
  await act(() =>
    (
      screen.getByRole("button", { name: "Stop generation" }).element() as HTMLButtonElement
    ).click(),
  );
  await act(() => vi.advanceTimersByTime(9_999));
  expect(screen.getByRole("button", { name: "Stopping", exact: true }).element()).toBeDisabled();
  await act(() => vi.advanceTimersByTime(1));
  await act(() =>
    (
      screen.getByRole("button", { name: "Stop generation" }).element() as HTMLButtonElement
    ).click(),
  );
  await screen.rerender(
    <ComposerPrimaryActions {...props} isRunning={false} canInterrupt={false} canResume />,
  );
  await act(() =>
    (screen.getByRole("button", { name: "Resume thread" }).element() as HTMLButtonElement).click(),
  );
  expect(props.onInterrupt).toHaveBeenCalledTimes(2);
  expect(props.onResume).not.toHaveBeenCalled();
});

it("keeps Wasm Stop and Send independent across edits, a timeout, and a late stop", async () => {
  const props = setup();
  const submit = vi.fn();
  const onSubmitMessage = vi.fn((event: ReactMouseEvent<HTMLElement>) => event.preventDefault());
  const view = (running: boolean, hasSendableContent: boolean) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <ComposerPrimaryActions
        {...props}
        isRunning={running}
        canInterrupt={running}
        hasSendableContent={hasSendableContent}
        onSubmitMessage={onSubmitMessage}
        useDioxusSubmit
      />
    </form>
  );
  await using screen = await render(view(true, false));
  const stop = screen.getByRole("button", { name: "Stop generation", exact: true });
  await expect.element(stop).toBeEnabled();
  const stopButton = stop.element() as HTMLButtonElement;
  expect(stopButton.type).toBe("button");
  expect(stopButton).toHaveAttribute("data-composer-stop-renderer", "dioxus-wasm");
  await screen.rerender(view(true, true));
  const send = screen.getByRole("button", { name: "Steer message", exact: true });
  await expect.element(send).toBeEnabled();
  const sendButton = send.element() as HTMLButtonElement;
  expect(sendButton).toHaveAttribute("data-composer-submit-renderer", "dioxus-wasm");
  expect(stop.element()).toBe(stopButton);

  await act(() => {
    sendButton.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }),
    );
  });
  expect(onSubmitMessage).toHaveBeenCalledTimes(1);
  expect(onSubmitMessage.mock.calls[0]?.[0].ctrlKey).toBe(true);
  expect(props.onInterrupt).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();

  using _timers = fakeTimers();
  await act(() => {
    stopButton.click();
    stopButton.click();
  });
  expect(stopButton).toBeDisabled();
  expect(props.onInterrupt).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTime(10_000));
  expect(stop.element()).toBe(stopButton);
  await act(() => stopButton.click());
  expect(props.onInterrupt).toHaveBeenCalledTimes(2);
  await screen.rerender(view(false, true));
  expect(stop.query()).toBeNull();
  expect(screen.getByRole("button", { name: "Submit message", exact: true }).element()).toBe(
    sendButton,
  );
  await act(() => sendButton.click());
  expect(onSubmitMessage).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTime(500));
  await act(() => sendButton.click());
  expect(submit).toHaveBeenCalledTimes(1);
});

it("keeps Stop pending across a permission failure", async () => {
  const props = setup();
  await using screen = await render(<ComposerPrimaryActions {...props} />);
  await act(() =>
    (
      screen.getByRole("button", { name: "Stop generation" }).element() as HTMLButtonElement
    ).click(),
  );
  await screen.rerender(
    <ComposerPrimaryActions {...props} canOperateThread={false} canInterrupt={false} />,
  );
  await screen.rerender(<ComposerPrimaryActions {...props} />);
  await expect
    .element(screen.getByRole("button", { name: "Stopping", exact: true }))
    .toBeDisabled();
  expect(props.onInterrupt).toHaveBeenCalledTimes(1);
});

it("keeps a pending stop when the run id clears and resets it for a different run", async () => {
  const props = setup();
  await using screen = await render(<ComposerPrimaryActions {...props} runId="first" />);
  await act(() =>
    (
      screen.getByRole("button", { name: "Stop generation" }).element() as HTMLButtonElement
    ).click(),
  );
  await screen.rerender(<ComposerPrimaryActions {...props} runId={null} />);
  expect(screen.getByRole("button", { name: "Stopping", exact: true }).element()).toBeDisabled();
  await screen.rerender(<ComposerPrimaryActions {...props} runId="second" />);
  expect(screen.getByRole("button", { name: "Stop generation" }).element()).toBeEnabled();
});

it("swaps the collapsed composer's send button for Stop while a turn can be stopped", async () => {
  const onInterrupt = vi.fn();
  const collapsed = (overrides: { canInterrupt?: boolean; hasSendableContent?: boolean } = {}) => (
    <CollapsedComposerStopAction
      canOperateThread
      canInterrupt={overrides.canInterrupt ?? true}
      runId="run"
      hasSendableContent={overrides.hasSendableContent ?? false}
      isEditingQueuedMessage={false}
      onInterrupt={onInterrupt}
    >
      <button type="button">Send message</button>
    </CollapsedComposerStopAction>
  );
  await using screen = await render(collapsed({ hasSendableContent: true }));
  await expect.element(screen.getByRole("button", { name: "Send message" })).toBeVisible();
  await screen.rerender(collapsed());
  await act(() =>
    (
      screen.getByRole("button", { name: "Stop generation" }).element() as HTMLButtonElement
    ).click(),
  );
  expect(onInterrupt).toHaveBeenCalledTimes(1);
  await expect
    .element(screen.getByRole("button", { name: "Stopping", exact: true }))
    .toBeDisabled();
  await screen.rerender(collapsed({ canInterrupt: false }));
  await expect.element(screen.getByRole("button", { name: "Send message" })).toBeVisible();
});
