import ExpoModulesCore

#if T3_IROH_ENABLED
import Foundation

public final class T3IrohModule: Module {
    private let tunnels = T3IrohTunnelStore(
        keychainService: (Bundle.main.bundleIdentifier ?? "T3Code") + ".iroh"
    )

    public func definition() -> ModuleDefinition {
        Name("T3Iroh")

        AsyncFunction("deviceEndpointId") { () async throws -> String in
            try await self.tunnels.endpointId()
        }

        AsyncFunction("open") {
            (endpoint: String, addresses: [String], relay: String?) async throws -> [String: String] in
            let lease = try await self.tunnels.open(endpoint: endpoint, addresses: addresses, relay: relay)
            return [
                "handle": lease.handle.uuidString,
                "port": String(lease.port),
            ]
        }

        AsyncFunction("close") { (handle: String) async throws in
            guard let id = UUID(uuidString: handle) else { throw Failure.invalidHandle }
            try await self.tunnels.close(handle: id)
        }
    }

    enum Failure: Error {
        case invalidHandle
    }
}

#else
public final class T3IrohModule: Module {
    public func definition() -> ModuleDefinition {
        Name("T3IrohUnavailable")
    }
}
#endif
