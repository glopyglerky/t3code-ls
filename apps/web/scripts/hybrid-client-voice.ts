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

function observeCaptureFailure() {
  const report = (stage: string, cause: unknown) =>
    console.error(`Synthetic voice capture ${stage}: ${cause instanceof Error ? cause.name : typeof cause}`);
  const microphone = navigator.mediaDevices;
  if (microphone) {
    const getUserMedia = microphone.getUserMedia.bind(microphone);
    microphone.getUserMedia = async (constraints) => {
      try {
        return await getUserMedia(constraints);
      } catch (cause) {
        report("getUserMedia", cause);
        throw cause;
      }
    };
  }
  if (typeof Worklet !== "undefined") {
    const addModule = Worklet.prototype.addModule;
    Worklet.prototype.addModule = async function (...args) {
      try {
        return await addModule.apply(this, args);
      } catch (cause) {
        report("addModule", cause);
        throw cause;
      }
    };
  }
  const resume = AudioContext.prototype.resume;
  AudioContext.prototype.resume = async function () {
    try {
      return await resume.call(this);
    } catch (cause) {
      report("resume", cause);
      throw cause;
    }
  };
}

export async function verifyBundledVoiceDraft(
  page: Page,
  readSubmissions: () => readonly string[],
  readAlternateSocketHosts: () => readonly string[],
  observePage: (page: Page) => void,
) {
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
  let release = Promise.withResolvers<boolean>();
  let responseServed = Promise.withResolvers<boolean>();
  let failDestination = false;
  const alternateHostAttempts: string[] = [];
  const context = page.context();
  const guardHost = async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      alternateHostAttempts.push(url.origin);
      await route.abort();
      return;
    }
    if (voiceUrl(url)) await serveSpeechFixture(route);
    else await route.fallback();
  };
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
      const complete = await release.promise;
      try {
        if (complete) await route.fulfill(failDestination
          ? { status: 503, json: { error: "Synthetic selected destination unavailable" } }
          : { json: { text: transcript } });
        else await route.abort();
        responseServed.resolve(complete);
      } catch {
        // Playwright may have already canceled the route during failed fixture cleanup.
        responseServed.resolve(false);
      }
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
  await context.route(/^https?:/u, guardHost);
  let concurrent: Page | undefined;
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

    await page.evaluate(observeCaptureFailure);
    const editor = page.getByTestId("composer-editor");
    const draft = "🚀 draft";
    await editor.fill(draft);
    await editor.press("End");
    const recording = page.getByRole("status", { name: "Recording", exact: true });
    await start.click();
    await recording.getByText(/^0:0[1-9](?: \/ 5:00)?$/u).waitFor({ state: "visible", timeout: 10_000 });
    const [request] = await Promise.all([
      page.waitForRequest((request) => request.url() === transcribeUrl && request.method() === "POST"),
      page.getByRole("button", { name: "Finish voice input", exact: true }).click(),
    ]);
    const encoded = request.postDataBuffer();
    Assert.ok(encoded, "The selected environment should receive binary PCM");
    const { pcm } = decodeSpeechPcmRequest(encoded);
    Assert.ok(pcm.length > 0 && pcm.length % 4 === 0, "Expected complete float32 PCM samples");
    await page.getByRole("status", { name: "Transcribing…", exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    Assert.equal(await editor.evaluate((element) => (element as HTMLElement).isContentEditable), false);
    Assert.equal(await editor.innerText(), draft);
    release.resolve(true);
    Assert.equal(await responseServed.promise, true, "The transcription response must reach the client");
    const expected = `${draft} ${transcript}`;
    await editor.filter({ hasText: expected }).waitFor({ state: "visible", timeout: 10_000 });
    Assert.equal(await editor.innerText(), expected);
    Assert.equal(await editor.evaluate((element) => (element as HTMLElement).isContentEditable), true);
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
    Assert.deepEqual(readSubmissions(), [], "Voice must never automatically submit a message");

    // A second real editor changes the durable draft while the selected destination is pending.
    // The recording editor is intentionally frozen by the production UI.
    release = Promise.withResolvers<boolean>();
    responseServed = Promise.withResolvers<boolean>();
    failDestination = true;
    const draftId = decodeURIComponent(new URL(draftRoute).pathname.split("/").at(-1)!);
    const saved = async (prompt: string) => {
      const handle = await page.waitForFunction(({ draftId, prompt }) => {
        const raw = localStorage.getItem("t3code:composer-drafts:v1");
        return raw !== null && JSON.parse(raw).state.draftsByThreadKey[draftId]?.prompt === prompt;
      }, { draftId, prompt }, { timeout: 10_000 });
      await handle.dispose();
    };
    await saved(expected);
    concurrent = await context.newPage();
    observePage(concurrent);
    await concurrent.goto(draftRoute, { waitUntil: "domcontentloaded" });
    const concurrentEditor = concurrent.getByTestId("composer-editor");
    await concurrentEditor.waitFor({ state: "visible" });
    Assert.equal(await concurrentEditor.innerText(), expected);
    await start.click();
    await recording.getByText(/^0:0[1-9](?: \/ 5:00)?$/u).waitFor({ state: "visible", timeout: 10_000 });
    const [failedRequest] = await Promise.all([
      page.waitForRequest((request) => request.url() === transcribeUrl && request.method() === "POST"),
      page.getByRole("button", { name: "Finish voice input", exact: true }).click(),
    ]);
    const failedEncoded = failedRequest.postDataBuffer();
    Assert.ok(failedEncoded);
    const failedPcm = decodeSpeechPcmRequest(failedEncoded).pcm;
    Assert.ok(failedPcm.length > 0 && failedPcm.length % 4 === 0);
    await page.getByRole("status", { name: "Transcribing…", exact: true }).waitFor({ state: "visible" });
    const concurrentLines = ["🦀 café e\u0301 👩‍💻 雪", "Concurrent unsent draft"];
    const concurrentDraft = concurrentLines.join("\n");
    await concurrentEditor.fill(concurrentDraft);
    await saved(concurrentDraft);
    Assert.deepEqual(await concurrentEditor.locator(":scope > p").allTextContents(), concurrentLines);
    release.resolve(true);
    Assert.equal(await responseServed.promise, true);
    await page.getByRole("status", {
      name: "Voice transcription failed. Check the destination in Settings → Voice.", exact: true,
    }).waitFor({ state: "visible" });
    Assert.equal(await editor.innerText(), expected);
    Assert.equal(await editor.evaluate((element) => (element as HTMLElement).isContentEditable), true);
    Assert.deepEqual(await concurrentEditor.locator(":scope > p").allTextContents(), concurrentLines);
    await saved(concurrentDraft);
    Assert.equal(page.url(), draftRoute);
    await page.getByRole("button", { name: "Dismiss voice input error", exact: true }).click();
    await start.waitFor({ state: "visible" });
    await saved(concurrentDraft);
    await concurrent.close();
    concurrent = undefined;
    await page.reload({ waitUntil: "domcontentloaded" });
    await editor.waitFor({ state: "visible" });
    Assert.deepEqual(await editor.locator(":scope > p").allTextContents(), concurrentLines);
    Assert.equal(await editor.evaluate((element) => (element as HTMLElement).isContentEditable), true);
    await start.waitFor({ state: "visible" });
    await saved(concurrentDraft);
    Assert.equal(page.url(), draftRoute);
    Assert.equal(transcriptionRequests, 2, "A failed destination must not be automatically retried");
    Assert.deepEqual(unexpectedWrites, []);
    Assert.deepEqual(alternateHostAttempts, []);
    Assert.deepEqual(readAlternateSocketHosts(), []);
    Assert.deepEqual(readSubmissions(), []);
    return {
      destination: "selected fixture environment",
      speechResponse: "deterministic HTTP fixture",
      pcmBytes: pcm.length,
      rustSelection,
      draftPreserved: true,
      cancellationPreservedDraft: true,
      remainedUnsent: true,
      transcriptionRequests: 1,
      failedDestination: {
        status: 503,
        pcmBytes: failedPcm.length,
        transcriptionRequests: transcriptionRequests - 1,
        concurrentDraft,
        concurrentDraftPreserved: true,
        errorDismissed: true,
        editorRecovered: true,
        reopenedDraft: concurrentDraft,
        durableDraftPreserved: true,
        noAutomaticRetry: true,
        noAutomaticSubmission: true,
        alternateHostAttempts,
        alternateSocketHosts: [...readAlternateSocketHosts()],
      },
    };
  } finally {
    release.resolve(false);
    await concurrent?.close();
    await context.unroute(/^https?:/u, guardHost);
  }
}
