// Diagnostic observer. Arrival of a matching success is an upper bound on commit.
// This sends no RPCs, changes no payloads and reads only the disposable fixture.
const [expectedPrompt] = arguments;
const state = { result: null, error: null, requests: 0 };
window.fixtureConversationAccept = state;
const original = WebSocket.prototype.send;
const sockets = new Map();
const epoch = () => performance.timeOrigin + performance.now();
function messages(text) {
  const value = JSON.parse(text);
  return Array.isArray(value) ? value : [value];
}
function observe(socket, data) {
  if (typeof data !== "string") return;
  let frames;
  try { frames = messages(data); } catch { return; }
  for (const frame of frames) {
    if (frame._tag !== "Request" || frame.tag !== "orchestration.launchThread" ||
        frame.payload?.initialMessage?.text !== expectedPrompt) continue;
    if (state.requests++ !== 0) { state.error = "duplicate fixture launch"; continue; }
    const command = frame.payload;
    if (!command.commandId || !command.threadId || !command.initialMessage.messageId ||
        command.projectId !== "conversation-fixture" ||
        command.modelSelection?.instanceId !== "devReplay" ||
        command.modelSelection?.model !== "todo-list") {
      state.error = "unexpected fixture launch identity";
      continue;
    }
    let pending = "";
    const listener = (event) => {
      const arrived = epoch();
      if (typeof event.data !== "string") return;
      if (event.data.startsWith("\u001e")) { pending += event.data.slice(1); return; }
      const text = pending + event.data;
      pending = "";
      let responses;
      try { responses = messages(text); } catch { return; }
      for (const response of responses) {
        if (response._tag !== "Exit" || String(response.requestId) !== String(frame.id)) continue;
        if (state.result || state.error) { state.error = "duplicate launch exit"; return; }
        const value = response.exit?.value;
        if (response.exit?._tag !== "Success" || value?.resumed !== false ||
            !Number.isSafeInteger(value?.sequence) || value.sequence <= 0 ||
            value.threadId !== command.threadId || value.projection?.thread?.id !== command.threadId) {
          state.error = "launch did not acknowledge a fresh committed message";
          return;
        }
        const users = value.projection.messages.filter(message => message.role === "user");
        if (users.length !== 1 || users[0].id !== command.initialMessage.messageId ||
            users[0].text !== expectedPrompt) {
          state.error = "launch projection does not match submitted message";
          return;
        }
        state.result = { commandId: command.commandId, requestId: String(frame.id),
          threadId: command.threadId, messageId: command.initialMessage.messageId,
          sequence: value.sequence, ackEpochMillis: arrived };
      }
    };
    socket.addEventListener("message", listener);
    sockets.set(socket, listener);
  }
}
function send(data) {
  observe(this, data);
  return original.call(this, data);
}
WebSocket.prototype.send = send;
state.stop = () => {
  if (WebSocket.prototype.send === send) WebSocket.prototype.send = original;
  for (const [socket, listener] of sockets) socket.removeEventListener("message", listener);
};
