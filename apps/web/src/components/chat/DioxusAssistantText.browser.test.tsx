import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { DioxusAssistantText } from "./DioxusAssistantText";

it("uses real Wasm for exact stream updates, replacement and resumed mount without moving composer focus", async () => {
  const row = (text: string, sequence: string, streaming = true) => <>
    <input aria-label="Synthetic composer" />
    <DioxusAssistantText text={text} sequence={sequence} updatedAt="2026-11-23T00:00:00.000Z" streaming={streaming}>
      <p data-retained="true">{text}</p>
    </DioxusAssistantText>
  </>;
  await using screen = await render(row("Hello", "7"));
  const native = () => screen.container.querySelector<HTMLElement>('[data-assistant-text-renderer="dioxus-wasm"]');
  await vi.waitFor(() => expect(native()?.textContent).toBe("Hello"));
  const node = native();
  const composer = screen.container.querySelector("input")!;
  composer.focus();
  for (const [text, sequence] of [["Hello 世界!", "8"], ["Hi", "9"]]) {
    await screen.rerender(row(text!, sequence!));
    await vi.waitFor(() => {
      expect(native()?.textContent).toBe(text);
      expect(native()?.dataset.snapshotSequence).toBe(sequence);
      expect(native()?.parentElement?.hidden).toBe(false);
    });
    expect(native()).toBe(node);
    expect(document.activeElement).toBe(composer);
  }
  for (const text of ["**rich text**", "1. item", "www.example.org", "a\nb"]) {
    await screen.rerender(row(text, "10"));
    await vi.waitFor(() => expect(native()?.dataset.supported).toBe("false"));
    expect(native()?.parentElement?.hidden).toBe(true);
    expect(screen.container.querySelector('[data-retained="true"]')?.textContent).toBe(text);
  }
  await screen.rerender(<input aria-label="Synthetic composer" />);
  expect(node?.isConnected).toBe(false);
  // Simulate a selected-thread remount with the reopened authoritative snapshot, then resume streaming.
  await screen.rerender(row("Restored", "11"));
  await vi.waitFor(() => expect(native()?.textContent).toBe("Restored"));
  await screen.rerender(row("Restored reply.", "12", false));
  await vi.waitFor(() => {
    expect(native()?.textContent).toBe("Restored reply.");
    expect(native()?.dataset.streaming).toBe("false");
    expect(native()?.dataset.snapshotSequence).toBe("12");
  });
});
