import {
  THREAD_MESSAGE_BASE_MAX_BYTES,
  type MessageId,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

interface MessageText {
  append(baseSequence: number, sequence: number, suffix: string): string | undefined;
  splice?(
    baseSequence: number,
    sequence: number,
    startUtf16: number,
    endUtf16: number,
    text: string,
  ): string | undefined;
  free(): void;
}

type CreateMessageText = (sequence: number, text: string, maxBytes: number) => MessageText | undefined;
export type DecodedThreadStreamItem = Exclude<
  OrchestrationV2ThreadStreamItem,
  { kind: "message-text-append" | "message-text-splice" }
>;

let binding: { readonly create: CreateMessageText; readonly version: 1 | 2 } | undefined;

export function installThreadMessageText(create: CreateMessageText, version: 1 | 2 = 1): void {
  binding = { create, version };
}

export function threadMessageTextVersion(): 1 | 2 | undefined {
  return binding?.version;
}

export function decodeThreadMessageText<E>(
  stream: Stream.Stream<OrchestrationV2ThreadStreamItem, E>,
  version: number | undefined,
): Stream.Stream<DecodedThreadStreamItem, E> {
  return Stream.suspend(() => {
    const create = version === 1 || version === 2 ? binding?.create : undefined;
    let base: { readonly id: MessageId; readonly text: MessageText } | undefined;
    const clear = () => {
      base?.text.free();
      base = undefined;
    };
    return stream.pipe(
      Stream.map((item): DecodedThreadStreamItem => {
        if (item.kind === "snapshot") clear();
        if (item.kind === "event" && item.event.type === "message.updated") {
          clear();
          const message = item.event.payload;
          if (
            create !== undefined &&
            message.role === "assistant" &&
            message.streaming &&
            message.text.length <= THREAD_MESSAGE_BASE_MAX_BYTES &&
            message.text.isWellFormed()
          ) {
            const text = create(item.sequence, message.text, THREAD_MESSAGE_BASE_MAX_BYTES);
            if (text !== undefined) base = { id: message.id, text };
          }
        }
        if (item.kind !== "message-text-append" && item.kind !== "message-text-splice") return item;

        const { event, sequence, baseSequence } = item;
        const message = event.payload;
        const matching = base?.id === message.id ? base.text : undefined;
        let text: string | undefined;
        if (
          matching !== undefined &&
          message.role === "assistant" &&
          message.streaming &&
          message.text.length <= THREAD_MESSAGE_BASE_MAX_BYTES &&
          message.text.isWellFormed()
        ) {
          if (item.kind === "message-text-append") {
            text = matching.append(baseSequence, sequence, message.text);
          } else if (
            version === 2 &&
            item.startUtf16 <= item.endUtf16 &&
            item.endUtf16 <= THREAD_MESSAGE_BASE_MAX_BYTES
          ) {
            text = matching.splice?.(
              baseSequence,
              sequence,
              item.startUtf16,
              item.endUtf16,
              message.text,
            );
          }
        }
        if (text === undefined) {
          throw new Error("The thread text update has no matching stream base");
        }
        return { kind: "event", sequence, event: { ...event, payload: { ...message, text } } };
      }),
      Stream.ensuring(Effect.sync(clear)),
    );
  });
}
