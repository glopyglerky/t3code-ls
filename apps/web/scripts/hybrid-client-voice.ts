// @effect-diagnostics nodeBuiltinImport:off - isolated built-application acceptance fixture.
import * as Assert from "node:assert/strict";
import { decodeSpeechPcmRequest } from "@t3tools/shared/speech";
import type { Page, Route } from "playwright";

const status = {
  supported: true,
  state: "ready",
  modelId: "fixture-local-speech",
  model: "Fixture speech",
  size: 1,
  supportsStreaming: false,
  supportsTranslation: false,
  acceleration: "cpu",
  benchmarkTier: "cpu",
  modelUnloadTimeout: "min_15",
  gpuDevices: [],
};

export async function verifyBundledVoiceDraft(page: Page) {
  const origin = new URL(page.url()).origin;
  const descriptor = await page.evaluate(async () => {
    const response = await fetch("/.well-known/t3/environment");
    if (!response.ok) throw new Error("Fixture environment descriptor was unavailable");
    return (await response.json()) as {
      environmentId: string;
      label: string;
      capabilities: { voiceTranscription?: boolean };
    };
  });
  Assert.equal(descriptor.capabilities.voiceTranscription, true);
  Assert.ok(descriptor.environmentId);
  await page.context().grantPermissions(["microphone"], { origin });
  const voiceUrl = (url: URL) => url.pathname.startsWith("/api/voice/");
  const transcribeUrl = `${origin}/api/voice/transcribe`;
  const transcript = "a recorded fixture phrase";
  const release = Promise.withResolvers<void>();
  const unexpectedWrites: string[] = [];
  let transcriptionRequests = 0;
  let statusRequests = 0;
  const serveSpeechFixture = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") {
      if (request.url() !== transcribeUrl || request.method() !== "POST") {
        unexpectedWrites.push(url.pathname);
        await route.abort();
        return;
      }
      transcriptionRequests += 1;
      await release.promise;
      await route.fulfill({ json: { text: transcript } });
      return;
    }
    if (url.pathname === "/api/voice/status") {
      statusRequests += 1;
      await route.fulfill({ json: status });
    } else if (url.pathname === "/api/voice/models") {
      await route.fulfill({ json: { models: [] } });
    } else {
      await route.fulfill({ status: 404 });
    }
  };
  await page.route(voiceUrl, serveSpeechFixture);
  try {
    await page.getByRole("button", { name: "New thread in hybrid-fixture", exact: true }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/draft/"));
    const draftRoute = page.url();
    const start = page.getByRole("button", { name: "Start voice input", exact: true });
    await start.click();
    await page.waitForURL((url) => url.pathname === "/settings/voice");
    await page.getByRole("combobox", { name: "Transcribe with", exact: true }).click();
    await page.getByRole("option", { name: descriptor.label, exact: true }).click();
    const grant = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("t3code:voice-audio-grant:v1") ?? "null"),
    );
    Assert.deepEqual(grant?.destination, {
      kind: "environment",
      environmentId: descriptor.environmentId,
    });
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForURL(draftRoute);

    const editor = page.getByTestId("composer-editor");
    await editor.fill("🚀 draft");
    await editor.press("End");
    const recording = page.getByRole("status", { name: "Recording", exact: true });
    await start.click();
    await recording.getByText(/^0:0[1-9] \/ 5:00$/u).waitFor({ state: "visible", timeout: 10_000 });
    const [request] = await Promise.all([
      page.waitForRequest((request) => request.url() === transcribeUrl && request.method() === "POST"),
      page.getByRole("button", { name: "Finish voice input", exact: true }).click(),
    ]);
    const encoded = request.postDataBuffer();
    Assert.ok(encoded, "The selected environment should receive binary PCM");
    const { pcm } = decodeSpeechPcmRequest(encoded);
    Assert.ok(pcm.length > 0 && pcm.length % 2 === 0, "Expected complete 16-bit PCM samples");
    await page.getByRole("status", { name: "Transcribing…", exact: true }).waitFor({ state: "visible" });
    const edited = "Updated 🚀 draft";
    await editor.fill(edited);
    const expected = `${edited} ${transcript}`;
    release.resolve();
    await editor.getByText(expected, { exact: true }).waitFor({ state: "visible" });
    Assert.equal(page.url(), draftRoute);
    const rustSelection = await page.evaluate(
      () => performance.getEntriesByName("t3-voice-rust-draft-selection").length === 1,
    );
    Assert.ok(rustSelection, "The built composer must use the Rust draft selection");

    await start.click();
    await recording.waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Cancel voice input", exact: true }).click();
    await start.waitFor({ state: "visible" });
    Assert.equal(await editor.innerText(), expected);
    Assert.equal(page.url(), draftRoute);
    Assert.equal(transcriptionRequests, 1);
    Assert.ok(statusRequests > 0);
    Assert.deepEqual(unexpectedWrites, []);
    return {
      destination: "selected fixture environment",
      speechResponse: "deterministic HTTP fixture",
      pcmBytes: pcm.length,
      rustSelection,
      concurrentDraftPreserved: true,
      cancellationPreservedDraft: true,
      remainedUnsent: true,
      transcriptionRequests,
    };
  } finally {
    release.resolve();
    await page.unroute(voiceUrl, serveSpeechFixture);
  }
}
