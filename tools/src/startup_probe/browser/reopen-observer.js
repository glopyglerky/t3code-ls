(() => {
  const expectedPath = REOPEN_EXPECTED_PATH;
  const selectedThreadId = REOPEN_THREAD_ID;
  if (location.pathname !== expectedPath) return;
  const timing = {
    firstShellVisibleMillis: 0, selectedTextVisibleMillis: 0, composerInteractiveMillis: 0,
    authoritativeShellHttpMillis: 0, authoritativeThreadHttpMillis: 0,
    authoritativeThreadMillis: 0, threadFreshnessTransport: null, threadResumeAfterSequence: null,
    shellHttpStatus: 0, threadHttpStatus: 0, frames: 0, maxFrameGapMillis: 0,
  };
  window.fixtureReopenTiming = timing;
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const request = args[0];
    const url = new URL(typeof request === "string" || request instanceof URL ? request : request.url, location.href);
    if (url.origin !== location.origin) return response;
    const key = url.pathname === "/api/orchestration/shell" ? "Shell" :
      url.pathname === `/api/orchestration/threads/${encodeURIComponent(selectedThreadId)}/bounded` ? "Thread" : null;
    if (key && timing[`authoritative${key}HttpMillis`] === 0) {
      response.clone().arrayBuffer().then(() => {
        if (timing[`authoritative${key}HttpMillis`] !== 0) return;
        timing[`authoritative${key}HttpMillis`] = performance.now();
        timing[`${key.toLowerCase()}HttpStatus`] = response.status;
        if (key === "Thread" && response.status === 200 && !timing.authoritativeThreadMillis) {
          timing.authoritativeThreadMillis = performance.now();
          timing.threadFreshnessTransport = "http-snapshot";
        }
      }).catch(() => {});
    }
    return response;
  };
  // Warm thread caches resume on the normal app socket without loading HTTP.
  // Correlate the server catch-up marker to that app's selected-thread request.
  const subscriptions = new WeakMap();
  const originalSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    const url = new URL(this.url);
    if (url.host === location.host && url.pathname === "/ws" && typeof data === "string") {
      if (!subscriptions.has(this)) {
        subscriptions.set(this, new Map());
        // Match shared/socketFrameParts.ts, with a bounded observation buffer.
        let pending = "";
        this.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          const part = event.data.startsWith("\u001e");
          const frame = pending + (part ? event.data.slice(1) : event.data);
          pending = "";
          if (frame.length > 16 * 1024 * 1024) return;
          if (part) { pending = frame; return; }
          let decoded;
          try { decoded = JSON.parse(frame); } catch { return; }
          for (const item of Array.isArray(decoded) ? decoded : [decoded]) {
            const subscription = subscriptions.get(this).get(item?.requestId);
            if (!subscription) continue;
            if (item._tag === "Exit") subscriptions.get(this).delete(item.requestId);
            if (item._tag !== "Chunk" || !Array.isArray(item.values) ||
                !item.values.some((value) => value?.kind === "synchronized")) continue;
            if (!timing.authoritativeThreadMillis) {
              timing.authoritativeThreadMillis = performance.now();
              timing.threadFreshnessTransport = "websocket-synchronized";
              timing.threadResumeAfterSequence = subscription.afterSequence;
            }
          }
        });
      }
      let decoded;
      try { decoded = JSON.parse(data); } catch { return originalSend.call(this, data); }
      for (const item of Array.isArray(decoded) ? decoded : [decoded]) {
        if (item?._tag === "Request" && item.tag === "orchestration.subscribeThread" &&
            item.payload?.threadId === selectedThreadId &&
            item.payload.requestCompletionMarker === true &&
            Number.isSafeInteger(item.payload.afterSequence) && item.payload.afterSequence >= 0) {
          subscriptions.get(this).set(item.id, { afterSequence: item.payload.afterSequence });
        }
        if (item?._tag === "Interrupt") subscriptions.get(this).delete(item.requestId);
      }
    }
    return originalSend.call(this, data);
  };
  let previous;
  function frame(now) {
    timing.frames++;
    if (previous !== undefined) timing.maxFrameGapMillis = Math.max(timing.maxFrameGapMillis, now - previous);
    previous = now;
    const row = [...document.querySelectorAll("[data-thread-item]")].find((element) =>
      element.textContent.includes("Reopen fixture 0000") && element.getClientRects().length > 0);
    if (!timing.firstShellVisibleMillis && row) timing.firstShellVisibleMillis = now;
    const main = document.querySelector("main, [role=main]");
    if (!timing.selectedTextVisibleMillis && main?.innerText.includes("Reopen fixture 0000 assistant 0199")) {
      timing.selectedTextVisibleMillis = now;
    }
    const editor = document.querySelector('[data-testid=composer-editor][contenteditable=true]');
    if (!timing.composerInteractiveMillis && editor?.getClientRects().length > 0) timing.composerInteractiveMillis = now;
    if (now < 30_000 && (!timing.firstShellVisibleMillis || !timing.selectedTextVisibleMillis || !timing.composerInteractiveMillis || !timing.authoritativeShellHttpMillis || !timing.authoritativeThreadMillis)) {
      requestAnimationFrame(frame);
    }
  }
  requestAnimationFrame(frame);
})();
