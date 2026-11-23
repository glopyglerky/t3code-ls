import {
  THREAD_MESSAGE_BASE_MAX_BYTES,
  type MessageId,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

interface MessageText {
  append(baseSequence: number, sequence: number, suffix: string): string | undefined;
  free(): void;
}

type CreateMessageText = (sequence: number, text: string, maxBytes: number) => MessageText | undefined;
type DecodedItem = Exclude<OrchestrationV2ThreadStreamItem, { kind: "message-text-append" }>;

let createMessageText: CreateMessageText | undefined;

export function installThreadMessageText(create: CreateMessageText): void {
  createMessageText = create;
}

export function canDecodeThreadMessageText(): boolean {
  return createMessageText !== undefined;
}

export function decodeThreadMessageText<E>(
  stream: Stream.Stream<OrchestrationV2ThreadStreamItem, E>,
  enabled: boolean,
): Stream.Stream<DecodedItem, E> {
  return Stream.suspend(() => {
    const create = enabled ? createMessageText : undefined;
    let base: { readonly id: MessageId; readonly text: MessageText } | undefined;
    const clear = () => {
      base?.text.free();
      base = undefined;
    };
    return stream.pipe(
      Stream.map((item): DecodedItem => {
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
        if (item.kind !== "message-text-append") return item;

        const { event, sequence, baseSequence } = item;
        const message = event.payload;
        const text =
          base?.id === message.id &&
          message.role === "assistant" &&
          message.streaming &&
          message.text.length <= THREAD_MESSAGE_BASE_MAX_BYTES &&
          message.text.isWellFormed()
            ? base.text.append(baseSequence, sequence, message.text)
            : undefined;
        if (text === undefined) {
          throw new Error("The thread text update has no matching stream base");
        }
        return { kind: "event", sequence, event: { ...event, payload: { ...message, text } } };
      }),
      Stream.ensuring(Effect.sync(clear)),
    );
  });
}
