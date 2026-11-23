import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(process.argv[2] ?? new URL("./reopen-observer.js", import.meta.url), "utf8")
  .replace("REOPEN_EXPECTED_PATH", JSON.stringify("/local/selected"))
  .replace("REOPEN_THREAD_ID", JSON.stringify("selected"));

function harness() {
  class Socket {
    constructor(url = "ws://127.0.0.1:1234/ws") { this.url = url; this.sent = []; this.listeners = []; }
    send(data) { this.sent.push(data); }
    addEventListener(type, listener) { assert.equal(type, "message"); this.listeners.push(listener); }
    receive(item) { this.raw(JSON.stringify(item)); }
    raw(data) { for (const listener of this.listeners) listener({ data }); }
  }
  const frames = [];
  const window = { fetch: async () => ({ status: 200, clone: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) }) };
  const visible = { getClientRects: () => [1] };
  const document = {
    querySelectorAll: () => [{ ...visible, textContent: "Reopen fixture 0000" }],
    querySelector: (selector) => selector.startsWith("main")
      ? { innerText: "Reopen fixture 0000 assistant 0199" } : visible,
  };
  vm.runInNewContext(source, {
    window, document, WebSocket: Socket, URL,
    location: new URL("http://127.0.0.1:1234/local/selected"),
    performance: { now: () => 25 }, requestAnimationFrame: (callback) => frames.push(callback),
  });
  return { Socket, window, frames, timing: window.fixtureReopenTiming };
}
const request = (payload = {}) => ({
  _tag: "Request", id: "thread-request", tag: "orchestration.subscribeThread", headers: [],
  payload: { threadId: "selected", afterSequence: 6400, requestCompletionMarker: true, ...payload },
});
const marker = (requestId = "thread-request") => ({ _tag: "Chunk", requestId, values: [{ kind: "synchronized" }] });

// The stock warm-cache contract: zero HTTP thread loads, one correlated catch-up marker.
{
  const { Socket, window, frames, timing } = harness();
  const socket = new Socket();
  const frame = JSON.stringify(request());
  socket.send(frame);
  socket.receive(marker("foreign-request"));
  assert.equal(timing.authoritativeThreadMillis ?? 0, 0);
  const synchronized = JSON.stringify(marker());
  socket.raw("\u001e" + synchronized.slice(0, 20));
  assert.equal(timing.authoritativeThreadMillis ?? 0, 0);
  socket.raw(synchronized.slice(20));
  await window.fetch("/api/orchestration/shell");
  await new Promise((resolve) => setImmediate(resolve));
  frames.shift()(30);
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0], frame);
  assert.equal(timing.authoritativeThreadHttpMillis, 0);
  assert.equal(timing.authoritativeThreadMillis, 25);
  assert.equal(timing.threadFreshnessTransport, "websocket-synchronized");
  assert.equal(timing.threadResumeAfterSequence, 6400);
  assert.equal(timing.shellHttpStatus, 200);
  assert.equal(timing.firstShellVisibleMillis, 30);
  assert.equal(timing.selectedTextVisibleMillis, 30);
  assert.equal(timing.composerInteractiveMillis, 30);
}
for (const payload of [{ threadId: "foreign" }, { requestCompletionMarker: false }, { afterSequence: null }]) {
  const { Socket, timing } = harness();
  const socket = new Socket();
  socket.send(JSON.stringify(request(payload)));
  socket.receive(marker());
  assert.equal(timing.authoritativeThreadMillis ?? 0, 0);
}
for (const tag of ["Interrupt", "Exit"]) {
  const { Socket, timing } = harness();
  const socket = new Socket();
  socket.send(JSON.stringify(request()));
  const terminal = { _tag: tag, requestId: "thread-request" };
  if (tag === "Interrupt") socket.send(JSON.stringify(terminal));
  else socket.receive(terminal);
  socket.receive(marker());
  assert.equal(timing.authoritativeThreadMillis ?? 0, 0);
}
{
  const { Socket, timing } = harness();
  const socket = new Socket("ws://127.0.0.1:9999/ws");
  socket.send(JSON.stringify(request()));
  socket.receive(marker());
  assert.equal(timing.authoritativeThreadMillis ?? 0, 0);
}
{
  const { window, timing } = harness();
  await window.fetch("/api/orchestration/threads/selected/bounded");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timing.threadFreshnessTransport, "http-snapshot");
  assert.equal(timing.threadHttpStatus, 200);
  assert.equal(timing.authoritativeThreadMillis, 25);
}
console.log("reopen observer: warm resume, request correlation, cancellation, and HTTP snapshot passed");
