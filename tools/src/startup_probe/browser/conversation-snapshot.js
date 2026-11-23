const [expectedPrompt, done] = arguments;
const locationParts = location.pathname.split("/").filter(Boolean);
if (locationParts.length !== 2 || locationParts[0] === "draft") {
  done({ valid: false });
} else {
  const threadId = decodeURIComponent(locationParts[1]);
  fetch(`/api/orchestration/threads/${encodeURIComponent(threadId)}`, {
    headers: { "x-t3-orchestration-protocol": "2" },
    cache: "no-store",
  }).then(async (result) => {
    if (!result.ok) return { valid: false };
    const { projection } = await result.json();
    const users = projection.messages.filter((message) => message.role === "user");
    const assistant = projection.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.text);
    return {
      valid:
        projection.thread.id === threadId &&
        projection.thread.modelSelection?.instanceId === "devReplay" &&
        projection.thread.modelSelection?.model === "todo-list" &&
        projection.runs.length === 1 &&
        projection.runs[0].status === "completed" &&
        users.length === 1 &&
        users[0].text === expectedPrompt &&
        assistant.some((text) => text.includes("I'll track the three steps and inspect both files.")) &&
        assistant.at(-1)?.includes("todo list fixture complete") === true,
      assistant,
    };
  }).then(done, () => done({ valid: false }));
}
