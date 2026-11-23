import type { TerminalAttachStreamEvent, TerminalSessionSnapshot } from "@t3tools/contracts";

type WireCounters = {
  sockets: number;
  opened: number;
  closed: number;
  errors: number;
  sent: number;
  received: number;
  binary: number;
  parts: number;
  oversized: number;
  invalidJson: number;
  attachRequests: number;
  observeRequests: number;
  chunks: number;
  exits: number;
  outputs: number;
  snapshots: number;
  mismatchedEvents: number;
  overflow: number;
};

export type TerminalWireWindow = Window & {
  __t3FixtureTerminalWire?: {
    counters: WireCounters;
    output: string;
    snapshot?: TerminalSessionSnapshot;
  };
};

export function installTerminalWireObserver({
  origin,
  threadId,
  terminalId,
  attachTag,
  observeTag,
  framePartsParam,
}: {
  origin: string;
  threadId: string;
  terminalId: string;
  attachTag: string;
  observeTag: string;
  framePartsParam: string;
}) {
  if (window !== window.top || location.origin !== origin) return;

  const counters: WireCounters = {
    sockets: 0,
    opened: 0,
    closed: 0,
    errors: 0,
    sent: 0,
    received: 0,
    binary: 0,
    parts: 0,
    oversized: 0,
    invalidJson: 0,
    attachRequests: 0,
    observeRequests: 0,
    chunks: 0,
    exits: 0,
    outputs: 0,
    snapshots: 0,
    mismatchedEvents: 0,
    overflow: 0,
  };
  const wire: NonNullable<TerminalWireWindow["__t3FixtureTerminalWire"]> = { counters, output: "" };
  (window as TerminalWireWindow).__t3FixtureTerminalWire = wire;

  // Keep one attach stream per document. Request IDs are local to their socket.
  const matchTerminal = (identity: { threadId?: string; terminalId?: string } | undefined) =>
    identity?.threadId === threadId && identity.terminalId === terminalId;
  const socketOrigin = origin.replace(/^http/u, "ws");
  const decoder = new TextDecoder();
  const nativeSend = WebSocket.prototype.send;
  window.WebSocket = new Proxy(window.WebSocket, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget) as WebSocket;
      const url = new URL(socket.url);
      if (url.origin !== socketOrigin || url.pathname !== "/ws") return socket;

      counters.sockets++;
      const splitFrames = url.searchParams.has(framePartsParam);
      let attachId: string | undefined;
      let pending = "";
      let discarding = false;
      socket.addEventListener("open", () => counters.opened++);
      socket.addEventListener("close", () => counters.closed++);
      socket.addEventListener("error", () => counters.errors++);
      socket.send = function (this: WebSocket, data: Parameters<WebSocket["send"]>[0]) {
        nativeSend.call(this, data);
        counters.sent++;
        if (typeof data !== "string" || (!data.includes(attachTag) && !data.includes(observeTag)))
          return;
        let request: {
          _tag?: string;
          id?: string | number;
          tag?: string;
          payload?: { threadId?: string; terminalId?: string };
        } | null;
        try {
          request = JSON.parse(data) as typeof request;
        } catch {
          counters.invalidJson++;
          return;
        }
        if (
          request?._tag !== "Request" ||
          request.id === undefined ||
          !matchTerminal(request.payload)
        )
          return;
        if (request.tag === attachTag) {
          if (++counters.attachRequests === 1) attachId = String(request.id);
        } else if (request.tag === observeTag) {
          counters.observeRequests++;
        }
      };
      socket.addEventListener("message", (message) => {
        if (!message.isTrusted) return;
        counters.received++;
        if (typeof message.data !== "string") counters.binary++;
        const frame =
          typeof message.data === "string"
            ? message.data
            : message.data instanceof ArrayBuffer
              ? decoder.decode(message.data)
              : undefined;
        if (frame === undefined) return;
        const more = splitFrames && frame.startsWith("\u001e");
        if (more) counters.parts++;
        if (discarding) {
          discarding = more;
          return;
        }
        if (pending.length + frame.length > 4 * 1024 * 1024) {
          counters.oversized++;
          pending = "";
          discarding = more;
          return;
        }
        if (more) {
          pending += frame.slice(1);
          return;
        }
        const json = pending + frame;
        pending = "";
        let envelope: {
          _tag?: string;
          requestId?: string | number;
          values?: TerminalAttachStreamEvent[];
        } | null;
        try {
          envelope = JSON.parse(json) as typeof envelope;
        } catch {
          counters.invalidJson++;
          return;
        }
        if (attachId === undefined || String(envelope?.requestId) !== attachId) return;
        if (envelope?._tag === "Exit") counters.exits++;
        if (envelope?._tag !== "Chunk" || !Array.isArray(envelope.values)) return;
        counters.chunks++;
        for (const event of envelope.values) {
          if (event.type === "snapshot") {
            if (!matchTerminal(event.snapshot)) {
              counters.mismatchedEvents++;
              continue;
            }
            counters.snapshots++;
            if (event.snapshot.history.length > 512 * 1024) counters.overflow++;
            else wire.snapshot = event.snapshot;
          } else if (event.type === "output") {
            if (!matchTerminal(event)) {
              counters.mismatchedEvents++;
              continue;
            }
            counters.outputs++;
            if (wire.output.length + event.data.length > 64 * 1024) counters.overflow++;
            else wire.output += event.data;
          }
        }
      });
      return socket;
    },
  });
}
