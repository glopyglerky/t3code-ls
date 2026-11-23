import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(`${process.argv[2]}/tools/src/startup_probe/browser/reopen-completed-observer.js`, "utf8")
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

// Selected visit observation never sends or retries a command.
const visitRequest = (threadId = "selected") => ({_tag:"Request", id:"visit", tag:"orchestration.dispatchCommand",
  payload:{type:"thread.visit", commandId:"real-command", threadId, visitedAt:"2026-11-01T00:00:00.000Z", opened:true}});
for (const exit of ["Success", "Failure"]) {
  const {Socket,timing} = harness(); const socket = new Socket();
  const wire = JSON.stringify(visitRequest()); socket.send(wire);
  socket.receive({_tag:"Exit",requestId:"foreign",exit:{_tag:"Success"}});
  assert.equal(timing.visits[0].receiptMillis,0);
  socket.receive({_tag:"Exit",requestId:"visit",exit:{_tag:exit}});
  assert.equal(timing.visits[0].exit,exit); assert.equal(timing.visits[0].receiptMillis,25);
  assert.deepEqual(socket.sent,[wire]);
}
{
  const {Socket,timing} = harness(); const socket = new Socket();
  socket.send(JSON.stringify(visitRequest("foreign")));
  assert.equal(timing.visits.length,0);
  socket.send(JSON.stringify(visitRequest()));
  socket.send(JSON.stringify({_tag:"Interrupt",requestId:"visit"}));
  socket.receive({_tag:"Exit",requestId:"visit",exit:{_tag:"Success"}});
  assert.equal(timing.visits[0].exit,"Interrupt");
}
{
  const {Socket,timing} = harness(); const socket = new Socket();
  socket.send(JSON.stringify(visitRequest()));
  assert.equal(timing.visits[0].exit,null); // pending receipt is not success
  for (let i=1;i<8;i++) socket.send(JSON.stringify({...visitRequest(),id:`visit-${i}`}));
  socket.send(JSON.stringify({...visitRequest(),id:"visit-9"}));
  assert.equal(timing.visitOverflow,true); assert.equal(socket.sent.length,9);
}
const cacheSource = readFileSync(`${process.argv[2]}/tools/src/startup_probe/browser/reopen-cache-exact.js`,"utf8");
const messages = [
  { id: "m0", role: "assistant", text: "outside the bounded view" },
  { id: "m1", role: "user", text: "one" },
  { id: "m2", role: "assistant", text: "two" },
];
async function cacheHarness(change = () => {}) {
  const bounded = { snapshotSequence: 12, projection: { thread: { id: "selected" }, messages: structuredClone(messages.slice(1)) } };
  const shell={schemaVersion:3,environmentId:"local",snapshot:{snapshotSequence:12,threads:[{id:"selected",projectId:"reopen-fixture"}]}};
  const thread={schemaVersion:5,environmentId:"local",threadId:"selected",snapshot:structuredClone(bounded)};
  change(shell, thread, bounded);
  let reads=[];
  const result=await new Promise(resolve=>{
    const tx={objectStore: store=>({get: key=>{reads.push([store,key]);return {result:JSON.stringify(store==="shell"?shell:thread)};}})};
    const db={objectStoreNames:{contains:()=>true},close(){},transaction(stores,mode){assert.equal(mode,"readonly");queueMicrotask(()=>tx.oncomplete());return tx;}};
    const indexedDB={open(name){assert.equal(name,"t3code:connection-runtime");const request={result:db};queueMicrotask(()=>request.onsuccess());return request;}};
    const fetch = async (path, options) => {
      assert.equal(path, "/api/orchestration/threads/selected/bounded?deferWork=1");
      assert.equal(options.headers["x-t3-orchestration-protocol"], "2");
      return { ok: true, json: async () => bounded };
    };
    vm.runInNewContext(`(function(){${cacheSource}}).apply(null,args)`,{fetch,indexedDB,location:new URL("http://localhost/local/selected"),args:["selected",{shellSequence:12,threadSequence:12,messages},resolve]});
  });
  assert.deepEqual(reads, result.reason === "bounded-content" ? [] : [["shell","local"],["thread","local:selected"]]);
  return result;
}
assert.equal((await cacheHarness()).valid,true);
for (const change of [
  (a,b)=>a.environmentId="foreign", (a,b)=>b.environmentId="foreign",
  (a,b)=>b.threadId="foreign", (a,b)=>b.snapshot.projection.thread.id="foreign",
  (a,b)=>b.snapshot.snapshotSequence=11, (a,b)=>a.snapshot.snapshotSequence=13,
  (a,b)=>b.snapshot.projection.messages.reverse(), (a,b)=>b.schemaVersion=6,
  (a,b)=>a.snapshot.threads[0].projectId="foreign",
  (a,b)=>b.snapshot.projection.messages = structuredClone(messages),
  (a,b,c)=>c.snapshotSequence=11,
  (a,b,c)=>c.projection.thread.id="foreign",
  (a,b,c)=>c.projection.messages.reverse(),
]) assert.equal((await cacheHarness(change)).valid,false);
console.log("completed-work faults: foreign/pending/rejected/interrupted/excess visits and exact scoped cache passed");
