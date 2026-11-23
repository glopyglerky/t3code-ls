import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import ChatMarkdown from "../ChatMarkdown";
import { captureAssistantTextSelection, resolveAssistantCitationRange } from "../../lib/assistantTextSelection";
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
  for (const text of ["***rich text***", "1. item", "www.example.org", "a\nb"]) {
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

// Uses the real loader and produced Wasm, never a mock renderer. The retained
// application pipeline is the differential oracle, including all escaping.
it("matches retained inline markup and citation offsets across bounded streaming replacements", async () => {
  const row = (text: string, sequence: string) => <>
    <input aria-label="Inline composer" />
    <div data-inline-oracle><ChatMarkdown text={text} cwd={undefined} /></div>
    <div data-inline-source data-assistant-citation-source="synthetic-inline">
      <DioxusAssistantText text={text} sequence={sequence} updatedAt="2026-11-23T00:00:00.000Z" streaming>
        <div data-inline-retained><ChatMarkdown text={text} cwd={undefined} /></div>
      </DioxusAssistantText>
    </div>
  </>;
  await using screen = await render(row("Hello **world**!", "20"));
  const native = () => screen.container.querySelector<HTMLElement>('[data-assistant-text-renderer="dioxus-wasm"]')!;
  const original = await vi.waitFor(() => {
    expect(native()?.parentElement?.hidden).toBe(false);
    return native();
  });
  const composer = screen.container.querySelector("input")!;
  composer.focus();
  let sequence = 20;
  const accepted = [
    "Hello **world**!", "Hello **world**! More *words*.",
    "I'll **inspect both files**.", "Hello **世界**!", "**don't** *stop*.",
    "**" + "x".repeat(4092) + "**", "*x* ".repeat(31) + "*x*", "Hi **all**!",
  ];
  for (const text of accepted) {
    const stamp = String(++sequence);
    await screen.rerender(row(text, stamp));
    await vi.waitFor(() => {
      expect(native().dataset.sourceText).toBe(text);
      expect(native().dataset.snapshotSequence).toBe(stamp);
      expect(native().parentElement?.hidden).toBe(false);
    });
    expect(native()).toBe(original);
    const paragraph = native().querySelector("p")!;
    const oracle = screen.container.querySelector('[data-inline-oracle] p')!;
    // Full markup, attributes, escaped serialization and visible Unicode text.
    const markup = (element: Element) => {
      const copy = element.cloneNode(true) as Element;
      const comments = document.createTreeWalker(copy, NodeFilter.SHOW_COMMENT);
      const remove: Node[] = [];
      while (comments.nextNode()) remove.push(comments.currentNode);
      for (const node of remove) node.parentNode!.removeChild(node);
      return copy.outerHTML;
    };
    // Dioxus may retain fragment anchor comments; every element, attribute,
    // text character and escape in the user-visible markup must still match.
    expect(markup(paragraph)).toBe(markup(oracle));
    expect(paragraph.textContent).toBe(oracle.textContent);
    expect(native().querySelector("a, img, button, script, iframe, [onclick]")).toBeNull();
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const captured = captureAssistantTextSelection(screen.container, selection);
    expect(captured?.selector.text).toBe(paragraph.textContent);
    expect(captured?.selector.start).toBe(0);
    expect(captured?.selector.end).toBe(paragraph.textContent!.length);
    const source = screen.container.querySelector<HTMLElement>('[data-inline-source]')!;
    expect(resolveAssistantCitationRange(source, captured!.selector)?.toString()).toBe(paragraph.textContent);
    selection.removeAllRanges();
    expect(document.activeElement).toBe(composer);
  }
  // Every unsupported snapshot falls back as a whole. Never partially render
  // the accepted prefix and lose the remainder or enable link/media actions.
  for (const text of [
    "Hello **wor", "Hello **world*", "***nested***", "**bold *nested* text**",
    "a**intraword**", "** a**", "**a **", "**a**b", String.raw`\**escaped**`,
    "**a** &amp; b", "**a** <img src=x onerror=alert(1)>",
    "**a** [link](javascript:alert(1))", "**a** ![image](https://example.org/a.png)",
    "**a** [quote](t3-citation:source)", "**a** www.example.org", "**a** `code`",
    "**a** ~~strike~~", "**a**\nnext", "**שלום**", "**e\u0301**", "**😀**",
    "**" + "x".repeat(4093) + "**", "*x* ".repeat(32) + "*x*",
  ]) {
    const stamp = String(++sequence);
    await screen.rerender(row(text, stamp));
    await vi.waitFor(() => {
      expect(native().dataset.snapshotSequence).toBe(stamp);
      expect(native().dataset.supported).toBe("false");
      expect(native().parentElement?.hidden).toBe(true);
      expect(screen.container.querySelector('[data-inline-retained]')).not.toBeNull();
      expect(screen.container.querySelector('[data-inline-retained] .chat-markdown')?.innerHTML)
        .toBe(screen.container.querySelector('[data-inline-oracle] .chat-markdown')?.innerHTML);
      expect(native().querySelector('p, a, img, script, iframe')).toBeNull();
    });
  }
  await screen.rerender(row("Back **again**!", String(++sequence)));
  await vi.waitFor(() => expect(native().parentElement?.hidden).toBe(false));
  expect(native()).toBe(original);
});
