import Foundation

actor T3IrohTunnelStore {
    private let identity: T3IrohIdentity
    private var tunnels: [UUID: IrohTunnel] = [:]

    init(keychainService: String) {
        identity = T3IrohIdentity(service: keychainService)
    }

    func endpointId() throws -> String {
        try deviceEndpointId(secretKey: identity.bytes())
    }

    func open(endpoint: String, addresses: [String], relay: String?) throws -> Lease {
        let tunnel = try IrohTunnel.open(
            secretKey: identity.bytes(), remote: endpoint, addresses: addresses, relay: relay
        )
        guard let port = try tunnel.port() else { throw Failure.unavailable }
        let handle = UUID()
        tunnels[handle] = tunnel
        return Lease(handle: handle, port: port)
    }

    func close(handle: UUID) throws {
        try tunnels.removeValue(forKey: handle)?.close()
    }

    struct Lease: Sendable {
        let handle: UUID
        let port: UInt16
    }

    enum Failure: Error {
        case unavailable
    }
}
