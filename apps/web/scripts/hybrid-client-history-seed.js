const [workspaceRoot, threadCount, selectedThreadId, done] = arguments;
const headers = { "Content-Type": "application/json", "x-t3-orchestration-protocol": "2" };
const fail = (error) => done({ valid: false, error: String(error) });
(async () => {
  const created = await fetch("/api/projects/mutate", {
    method: "POST", headers,
    body: JSON.stringify({ type: "project.create", projectId: "reopen-fixture", commandId: "reopen-fixture-create", title: "reopen-fixture", workspaceRoot }),
  });
  if (!created.ok) throw new Error(`Project creation returned ${created.status}`);
  const ticketResponse = await fetch("/api/auth/websocket-ticket", { method: "POST" });
  if (!ticketResponse.ok) throw new Error(`Ticket returned ${ticketResponse.status}`);
  const { ticket } = await ticketResponse.json();
  const socketUrl = new URL("/ws", location.origin);
  socketUrl.protocol = "ws:";
  socketUrl.searchParams.set("wsTicket", ticket);
  socketUrl.searchParams.set("orchestrationProtocol", "2");
  let scannedThreadCount = 0;
  const imported = await new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    const timeout = setTimeout(() => { socket.close(); reject(new Error("Import timed out")); }, 90_000);
    const finish = (error, value) => {
      clearTimeout(timeout);
      socket.onclose = null;
      socket.close();
      if (error) reject(error);
      else resolve(value);
    };
    socket.onerror = () => finish(new Error("Import socket failed"));
    socket.onclose = () => finish(new Error("Import socket closed before its receipt"));
    socket.onopen = () => socket.send(JSON.stringify({
      _tag: "Request", id: "reopen-scan", tag: "agentSessions.scan", payload: {}, headers: [],
    }));
    socket.onmessage = (event) => {
      try {
        const decoded = JSON.parse(event.data);
        for (const item of Array.isArray(decoded) ? decoded : [decoded]) {
          if (item._tag === "Ping") { socket.send(JSON.stringify({ _tag: "Pong" })); continue; }
          // Welcome scanned before the fixture files existed. Import reuses the last scan.
          if (item.requestId === "reopen-scan" && item._tag === "Exit") {
            const scan = item.exit?._tag === "Success" ? item.exit.value : null;
            const candidate = scan?.candidates?.find((row) => row.path === workspaceRoot);
            if (scan?.truncated === true || candidate?.threadCount !== threadCount ||
                !candidate.sources.includes("codex")) {
              finish(new Error(`Fresh scan did not find ${threadCount} fixture threads`));
              return;
            }
            scannedThreadCount = candidate.threadCount;
            socket.send(JSON.stringify({
              _tag: "Request", id: "reopen-import", tag: "agentSessions.import",
              payload: { projectId: "reopen-fixture", expectedWorkspaceRoot: workspaceRoot }, headers: [],
            }));
            continue;
          }
          if (item.requestId !== "reopen-import") continue;
          if (item._tag === "Exit") {
            if (item.exit?._tag === "Success") finish(null, item.exit.value);
            else finish(new Error("History import returned a failed RPC exit"));
          }
        }
      } catch (error) { finish(error); }
    };
  });
  if (imported.importedCount !== threadCount || imported.skippedCount !== 0) {
    throw new Error(`Unexpected import counts ${JSON.stringify(imported)}`);
  }
  const response = await fetch("/api/orchestration/shell", { headers, cache: "no-store" });
  if (!response.ok) throw new Error(`Shell returned ${response.status}`);
  const shell = await response.json();
  const threads = shell.threads.filter((thread) => thread.projectId === "reopen-fixture");
  if (threads.length !== threadCount || !threads.some((thread) => thread.id === selectedThreadId)) {
    throw new Error("Authoritative shell is missing imported threads");
  }
  const descriptorResponse = await fetch("/.well-known/t3/environment", { cache: "no-store" });
  if (!descriptorResponse.ok) throw new Error(`Descriptor returned ${descriptorResponse.status}`);
  const descriptor = await descriptorResponse.json();
  if (typeof descriptor.environmentId !== "string" || descriptor.environmentId.length === 0) {
    throw new Error("Fixture descriptor is missing its environment ID");
  }
  const route = `/${encodeURIComponent(descriptor.environmentId)}/${encodeURIComponent(selectedThreadId)}`;
  done({ valid: true, scannedThreadCount, imported, shellSequence: shell.snapshotSequence, route });
})().catch(fail);
