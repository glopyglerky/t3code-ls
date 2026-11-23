const [expectedPrompt, accepted, done] = arguments;
const parts = location.pathname.split("/").filter(Boolean);
if (parts.length !== 2 || decodeURIComponent(parts[1]) !== accepted.threadId) {
  done({ valid: false });
} else {
  fetch(`/api/orchestration/threads/${encodeURIComponent(accepted.threadId)}`, {
    headers: { "x-t3-orchestration-protocol": "2" }, cache: "no-store",
  }).then(async response => {
    if (!response.ok) return { valid: false };
    const { projection } = await response.json();
    const users = projection.messages.filter(message => message.role === "user");
    const assistant = projection.messages.filter(message => message.role === "assistant");
    const plans = projection.plans.filter(plan => plan.kind === "todo_list");
    const summaries = projection.turnItems.filter(item => item.type === "dynamic_tool");
    if (summaries.length !== 2) return { valid: false };
    // Snapshot output is compacted. Read full details through the production RPC,
    // after the measured turn, on a separate authenticated, task-owned socket.
    const tools = await new Promise((resolve, reject) => {
      const url = new URL(location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = "/ws";
      url.search = "?orchestrationProtocol=2";
      url.hash = "";
      const socket = new WebSocket(url);
      const details = new Map();
      const timer = setTimeout(() => finish(new Error("fixture detail timeout")), 3000);
      function finish(error) {
        clearTimeout(timer);
        socket.close();
        if (error) reject(error);
        else resolve(summaries.map((_, i) => details.get(String(i + 1))));
      }
      socket.addEventListener("open", () => summaries.forEach((item, i) => socket.send(JSON.stringify({
        _tag: "Request", id: String(i + 1), tag: "orchestration.getTurnItem",
        payload: { threadId: accepted.threadId, itemId: item.id }, headers: [],
      }))));
      socket.addEventListener("error", () => finish(new Error("fixture detail transport")));
      socket.addEventListener("message", event => {
        try {
          const decoded = JSON.parse(event.data);
          for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
            if (frame._tag !== "Exit") continue;
            const index = Number(frame.requestId) - 1;
            if (!Number.isInteger(index) || index < 0 || index >= summaries.length ||
                frame.exit?._tag !== "Success" || frame.exit.value?.item?.id !== summaries[index].id ||
                frame.exit.value.item.threadId !== accepted.threadId ||
                frame.exit.value.item.type !== "dynamic_tool") {
              finish(new Error("fixture detail identity")); return;
            }
            details.set(String(frame.requestId), frame.exit.value.item);
          }
          if (details.size === summaries.length) finish();
        } catch { finish(new Error("fixture detail frame")); }
      });
    });
    const steps = ["Inspect package.json", "Inspect tsconfig.json", "Report completion"];
    const expectedReads = [
      { path: "package.json", content: '{"name":"t3"}' },
      { path: "tsconfig.json", content: '{"compilerOptions":{}}' },
    ];
    const work = {
      users: users.map(message => message.text),
      assistant: assistant.map(message => ({ text: message.text, streaming: message.streaming })),
      runs: projection.runs.map(run => run.status),
      plans: plans.map(plan => plan.steps.map(step => ({ text: step.text, status: step.status }))),
      reads: tools.map(item => ({ title: item.title, toolName: item.toolName, status: item.status, input: item.input, output: item.output })),
    };
    return {
      valid: projection.thread.id === accepted.threadId &&
        projection.thread.modelSelection?.instanceId === "devReplay" &&
        projection.thread.modelSelection?.model === "todo-list" &&
        projection.messages.length === 3 && users.length === 1 && users[0].id === accepted.messageId && users[0].text === expectedPrompt &&
        work.runs.length === 1 && work.runs[0] === "completed" &&
        assistant.length === 2 && assistant.every(message => message.streaming === false) &&
        assistant[0].text === "I'll track the three steps and inspect both files." &&
        assistant[1].text === "todo list fixture complete" &&
        plans.length === 1 && plans[0].steps.length === 3 &&
        plans[0].steps.every((step, i) => step.text === steps[i] && step.status === "completed") &&
        tools.length === 2 && tools.every((item, i) =>
          item.toolName === "Read" && item.status === "completed" && item.title === `Read ${expectedReads[i].path}` &&
          JSON.stringify(item.input) === JSON.stringify({ path: expectedReads[i].path }) &&
          JSON.stringify(item.output) === JSON.stringify({ content: expectedReads[i].content })),
      work,
    };
  }).then(done, () => done({ valid: false }));
}
