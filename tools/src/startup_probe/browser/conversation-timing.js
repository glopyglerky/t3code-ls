const timing = { firstVisibleMillis: 0, terminalMillis: 0, frames: 0, maxFrameGapMillis: 0 };
window.fixtureConversationTiming = timing;
function submit(event) {
  if (!event.isTrusted || !event.target.closest('button[aria-label="Submit message"]')) return;
  document.removeEventListener("click", submit, true);
  const started = performance.now();
  let previous;
  function frame(now) {
    if (previous !== undefined) timing.maxFrameGapMillis = Math.max(timing.maxFrameGapMillis, now - previous);
    previous = now;
    timing.frames++;
    const content = document.querySelector("main, [role=main]")?.innerText ?? "";
    if (timing.firstVisibleMillis === 0 && content.includes("I'll track the")) {
      timing.firstVisibleMillis = performance.now() - started;
    }
    const generating = document.querySelector('button[aria-label="Stop generation"], button[aria-label="Stopping"]');
    if (timing.firstVisibleMillis > 0 && content.includes("todo list fixture complete") && !generating) {
      timing.terminalMillis = performance.now() - started;
      return;
    }
    if (performance.now() - started < 30_000) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
document.addEventListener("click", submit, true);
