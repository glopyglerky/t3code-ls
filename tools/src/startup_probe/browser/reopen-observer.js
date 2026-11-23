(() => {
  const expectedPath = REOPEN_EXPECTED_PATH;
  const selectedThreadId = REOPEN_THREAD_ID;
  if (location.pathname !== expectedPath) return;
  const timing = {
    firstShellVisibleMillis: 0, selectedTextVisibleMillis: 0, composerInteractiveMillis: 0,
    authoritativeShellHttpMillis: 0, authoritativeThreadHttpMillis: 0,
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
      }).catch(() => {});
    }
    return response;
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
    if (now < 30_000 && (!timing.selectedTextVisibleMillis || !timing.authoritativeShellHttpMillis || !timing.authoritativeThreadHttpMillis)) {
      requestAnimationFrame(frame);
    }
  }
  requestAnimationFrame(frame);
})();
