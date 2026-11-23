const [selectedThreadId, threadCount, messageCount, done] = arguments;
const headers = { "x-t3-orchestration-protocol": "2" };
Promise.all([
  fetch("/api/orchestration/shell", { headers, cache: "no-store" }).then((response) => {
    if (!response.ok) throw new Error(`Shell returned ${response.status}`);
    return response.json();
  }),
  fetch(`/api/orchestration/threads/${encodeURIComponent(selectedThreadId)}`, { headers, cache: "no-store" }).then((response) => {
    if (!response.ok) throw new Error(`Thread returned ${response.status}`);
    return response.json();
  }),
]).then(([shell, snapshot]) => {
  const projection = snapshot.projection;
  const threads = shell.threads.filter((thread) => thread.projectId === "reopen-fixture");
  const messages = projection.messages;
  const prefix = "Reopen fixture 0000";
  done({
    valid: threads.length === threadCount && threads.some((thread) => thread.id === selectedThreadId) &&
      projection.thread.id === selectedThreadId && projection.runs.length === 0 && messages.length === messageCount &&
      messages.every((message, index) => message.role === (index % 2 ? "assistant" : "user") &&
        message.text === `${prefix} ${message.role} ${String(index).padStart(4, "0")}\n${"Synthetic saved history. ".repeat(8).trim()}`),
    shellSequence: shell.snapshotSequence,
    threadSequence: snapshot.snapshotSequence,
    threadCount: threads.length,
    messageCount: messages.length,
    selectedThreadId: projection.thread.id,
    messages: messages.map(({ id, role, text }) => ({ id, role, text })),
  });
}, (error) => done({ valid: false, error: String(error) }));
