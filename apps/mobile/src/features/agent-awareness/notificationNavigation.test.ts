import type { NotificationResponse } from "expo-notifications";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

import {
  extractAgentNotificationDeepLink,
  routeAgentNotificationResponseOnce,
} from "./notificationPayload";

function responseWithData(data: Record<string, unknown>, identifier = "notification-1") {
  return {
    notification: {
      request: {
        identifier,
        content: {
          data,
        },
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("consumeLastAgentNotificationResponse", () => {
  it("reports routing failures before clearing the response", async () => {
    const cause = new Error("notification routing unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = responseWithData({}, "notification-route") as NotificationResponse;
    const clearLastResponse = vi.fn(() => Promise.resolve());

    await consumeLastAgentNotificationResponse({
      getLastResponse: () => Promise.resolve(response),
      clearLastResponse,
      handleResponse: () => {
        throw cause;
      },
    });

    expect(clearLastResponse).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        _tag: "NotificationNavigationError",
        operation: "route",
        notificationId: "notification-route",
      }),
    );
  });
});

describe("extractAgentNotificationDeepLink", () => {
  it("uses explicit deep links from APNs payload data", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/threads/env/thread",
          environmentId: "ignored",
          threadId: "ignored",
        }),
      ),
    ).toBe("/threads/env/thread");
  });

  it("falls back to the thread route from environment and thread ids", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          environmentId: "env 1",
          threadId: "thread/2",
        }),
      ),
    ).toBe("/threads/env%201/thread%2F2");
  });

  it("falls back to ids when explicit deep link is not an agent thread route", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/",
          environmentId: "env",
          threadId: "thread",
        }),
      ),
    ).toBe("/threads/env/thread");
  });

  it("ignores malformed or external links", () => {
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "https://example.com" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "/settings" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "//example.com" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "/threads/env/thread?x=1" })),
    ).toBeNull();
    expect(extractAgentNotificationDeepLink({})).toBeNull();
  });
});

describe("routeAgentNotificationResponseOnce", () => {
  it("retries a failed initial response and deduplicates it after navigation succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = responseWithData({ deepLink: "/threads/env/thread" }) as NotificationResponse;
    const responses = new Map<string, Promise<void>>();
    const navigate = vi.fn().mockImplementationOnce(() => {
      throw new Error("navigation not ready");
    });
    const clearLastResponse = vi.fn(() => Promise.resolve());
    const consume = () =>
      consumeLastAgentNotificationResponse({
        getLastResponse: () => Promise.resolve(response),
        clearLastResponse,
        handleResponse: (response) =>
          routeAgentNotificationResponseOnce({ responses, response, navigate }),
      });

    await consume();
    expect(responses.size).toBe(0);
    expect(clearLastResponse).not.toHaveBeenCalled();

    await consume();
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenLastCalledWith("/threads/env/thread");
    expect(clearLastResponse).toHaveBeenCalledOnce();

    await routeAgentNotificationResponseOnce({ responses, response, navigate });
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it("discards malformed destination ids without leaving the response pending", async () => {
    const response = responseWithData({
      environmentId: "env",
      threadId: "\ud800",
    }) as NotificationResponse;
    const responses = new Map<string, Promise<void>>();
    const navigate = vi.fn();
    const clearLastResponse = vi.fn(() => Promise.resolve());

    await consumeLastAgentNotificationResponse({
      getLastResponse: () => Promise.resolve(response),
      clearLastResponse,
      handleResponse: (response) =>
        routeAgentNotificationResponseOnce({ responses, response, navigate }),
    });

    expect(navigate).not.toHaveBeenCalled();
    expect(clearLastResponse).toHaveBeenCalledOnce();
    expect(responses.has("notification-1")).toBe(true);
  });

  it("waits for dispatch before clearing a retained cold-start tap", async () => {
    const responses = new Map<string, Promise<void>>();
    const response = responseWithData({
      environmentId: "env",
      threadId: "thread",
    }) as NotificationResponse;
    const dispatched = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const navigate = vi.fn(() => {
      started.resolve();
      return dispatched.promise;
    });
    const clearLastResponse = vi.fn(() => Promise.resolve());
    const handleResponse = (response: NotificationResponse) =>
      routeAgentNotificationResponseOnce({ responses, response, navigate });

    const coldStart = consumeLastAgentNotificationResponse({
      getLastResponse: () => Promise.resolve(response),
      clearLastResponse,
      handleResponse,
    });
    await started.promise;
    const liveListener = handleResponse(response);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/threads/env/thread");
    expect(clearLastResponse).not.toHaveBeenCalled();

    dispatched.resolve();
    await Promise.all([coldStart, liveListener]);
    expect(clearLastResponse).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
  });
});
