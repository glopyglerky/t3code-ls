import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as RpcSession from "../rpc/session.ts";
import { BearerConnectionProfile, type ConnectionCatalogEntry } from "./catalog.ts";
import { IrohTransport } from "../platform/capabilities.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  SshConnectionTarget,
  type PreparedConnection,
} from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";

const sshTarget = (connectionId: string) =>
  new SshConnectionTarget({
    environmentId: EnvironmentId.make("environment-1"),
    label: "Test environment",
    connectionId,
  });

const ENTRY: ConnectionCatalogEntry = {
  target: sshTarget("ssh-first"),
  profile: Option.none(),
  enabled: true,
  alternateRoutes: [{ target: sshTarget("ssh-second"), profile: Option.none() }],
};

describe("ConnectionDriver", () => {
  it.effect("authorizes through the tunnel and closes its lease before trying another route", () =>
    Effect.gen(function* () {
      const operations = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (operation: string) =>
        Ref.update(operations, (current) => [...current, operation]);
      const target = new BearerConnectionTarget({
        environmentId: EnvironmentId.make("environment-1"),
        label: "Test environment",
        connectionId: "iroh-saved",
      });
      const peer = { endpointId: "a".repeat(64), addresses: ["192.0.2.2:3774"], relay: null };
      const entry: ConnectionCatalogEntry = {
        enabled: true,
        target,
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId: target.connectionId,
            environmentId: target.environmentId,
            label: target.label,
            httpBaseUrl: "https://saved.example/",
            wsBaseUrl: "wss://saved.example/",
            iroh: peer,
          }),
        ),
        alternateRoutes: [{ target: sshTarget("ssh-second"), profile: Option.none() }],
      };
      const driver = yield* ConnectionDriver.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(IrohTransport, {
              available: true,
              open: (input) =>
                Effect.acquireRelease(
                  record("open").pipe(
                    Effect.map(() => {
                      expect(input).toEqual(peer);
                      return {
                        httpBaseUrl: "http://127.0.0.1:31657",
                        wsBaseUrl: "ws://127.0.0.1:31657",
                      };
                    }),
                  ),
                  () => record("close"),
                ),
            }),
            Layer.mock(ConnectionResolver.ConnectionResolver)({
              prepare: (entry) =>
                Effect.gen(function* () {
                  const profile = Option.getOrNull(entry.profile);
                  if (profile?._tag === "BearerConnectionProfile") {
                    expect(profile.iroh).toBeUndefined();
                    expect(profile.httpBaseUrl).toBe("http://127.0.0.1:31657");
                    expect(profile.wsBaseUrl).toBe("ws://127.0.0.1:31657");
                    yield* record("authorize");
                  } else {
                    yield* record("fallback");
                  }
                  return {
                    environmentId: entry.target.environmentId,
                    label: entry.target.label,
                    target: entry.target,
                    httpBaseUrl: "http://127.0.0.1:31657",
                    socketUrl: "ws://127.0.0.1:31657/ws",
                    httpAuthorization: null,
                  } satisfies PreparedConnection;
                }),
            }),
            Layer.mock(RpcSession.RpcSessionFactory)({
              connect: () =>
                Effect.fail(
                  new ConnectionTransientError({ reason: "transport", detail: "Socket closed." }),
                ),
            }),
            Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({}),
            FetchHttpClient.layer,
          ),
        ),
      );
      yield* driver.connect(entry, () => Effect.void).pipe(Effect.scoped, Effect.flip);
      expect(yield* Ref.get(operations)).toEqual(["open", "authorize", "close", "fallback"]);
    }),
  );

  it.effect("reports preparing before each route it prepares", () =>
    Effect.gen(function* () {
      const stages = yield* Ref.make<ReadonlyArray<string>>([]);
      const driver = yield* ConnectionDriver.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ConnectionResolver.ConnectionResolver)({
              prepare: (entry) =>
                Effect.succeed({
                  environmentId: entry.target.environmentId,
                  label: entry.target.label,
                  httpBaseUrl: "http://127.0.0.1:1",
                  socketUrl: "ws://127.0.0.1:1/ws",
                  httpAuthorization: null,
                  target: entry.target,
                } satisfies PreparedConnection),
            }),
            Layer.mock(RpcSession.RpcSessionFactory)({
              connect: () =>
                Effect.fail(
                  new ConnectionTransientError({ reason: "transport", detail: "Socket closed." }),
                ),
            }),
            Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({}),
            // SSH routes have no HTTP check, so the driver never sends a request.
            FetchHttpClient.layer,
          ),
        ),
      );

      yield* driver
        .connect(ENTRY, (progress) => Ref.update(stages, (all) => [...all, progress.stage]))
        .pipe(Effect.scoped, Effect.flip);

      expect(yield* Ref.get(stages)).toEqual([
        "preparing",
        "preparing",
        "opening",
        "preparing",
        "opening",
      ]);
    }),
  );
});
