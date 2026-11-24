// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalJsonInEffect:off - synthetic provider fixture.
import * as FS from "node:fs";
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import { mcpToolSession } from "../src/mcp/AcpMcpStdioBridge.ts";

export const htmlFixtureTitle = "Controlled interactive document";

/** Uses only this controlled provider process's own production MCP session. */
export async function publishInteractiveHtml(input: {
  readonly signal: AbortSignal;
  readonly sendUpdate: (update: Readonly<Record<string, unknown>>) => void;
}): Promise<void> {
  const endpoint = process.env.T3_ACP_MCP_ENDPOINT;
  const authorization = process.env.T3_ACP_MCP_AUTHORIZATION;
  if (endpoint === undefined || authorization === undefined) throw new Error("Controlled HTML publisher has no own session.");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Controlled HTML publisher requires a valid local endpoint.");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/mcp" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "" || /[\r\n]/u.test(authorization)) {
    throw new Error("Controlled HTML publisher requires its local endpoint.");
  }
  const html = FS.readFileSync(new URL("./dev-replay/interactive_html.html", import.meta.url), "utf8");
  const args = { html, title: htmlFixtureTitle, height: 280 };
  let initialized = 0;
  let toolCalls = 0;
  let hasSession = false;
  let terminated = false;
  const fetchImplementation = async (target: string, init?: RequestInit): Promise<Response> => {
    if (String(target) !== endpoint) throw new Error("Controlled MCP request changed endpoint.");
    const message = typeof init?.body === "string" ? JSON.parse(init.body) as { method?: string; params?: { name?: string } } : null;
    if (message?.method === "initialize") initialized += 1;
    if (message?.method === "tools/call") {
      if (message.params?.name !== "html_render") throw new Error("Unexpected controlled tool.");
      toolCalls += 1;
    }
    const deadline = AbortSignal.timeout(10_000);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    const response = await fetch(target, { ...init, signal, redirect: "error" });
    hasSession ||= response.headers.has("mcp-session-id");
    if (init?.method === "DELETE") terminated = response.ok;
    return response;
  };
  const toolCallId = `controlled-html-${randomUUID()}`;
  input.sendUpdate({ sessionUpdate: "tool_call", toolCallId, kind: "other", title: "Render controlled HTML",
    status: "in_progress", rawInput: { server: "t3-code", tool: "html_render", arguments: args }, _meta: { is_mcp_tool_call: true } });
  let result: unknown;
  try {
    result = await Effect.runPromise(Effect.gen(function* () {
      const client = yield* mcpToolSession({ endpoint, authorization, clientName: "controlled-html-replay", fetchImplementation });
      return yield* client.call("html_render", args);
    }).pipe(Effect.scoped, Effect.timeout("30 seconds")), { signal: input.signal });
  } catch {
    throw new Error("Controlled HTML publication failed.");
  }
  if (initialized !== 1 || toolCalls !== 1 || (hasSession && !terminated) || htmlRenderFromToolItem({ toolName: "t3-code.html_render", output: result }) === undefined) {
    throw new Error("Controlled HTML publication did not complete its real session.");
  }
  input.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", rawOutput: result });
  input.sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text",
    text: `Interactive HTML fixture published. MCP initialized=1 tool=1 teardown=${hasSession ? "terminated" : "stateless"}.` } });
}
