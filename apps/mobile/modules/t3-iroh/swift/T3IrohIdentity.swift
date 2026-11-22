import Foundation
import Security

struct T3IrohIdentity {
    let service: String

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "iroh-device-key",
        ]
    }

    func bytes() throws -> Data {
        if let existing = try read() { return existing }

        var candidate = Data(count: 32)
        let generated = candidate.withUnsafeMutableBytes { buffer in
            guard let address = buffer.baseAddress else { return errSecParam }
            return SecRandomCopyBytes(kSecRandomDefault, buffer.count, address)
        }
        guard generated == errSecSuccess else { throw Failure.keychain(generated) }

        let attributes = query.merging([
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: candidate,
        ]) { _, new in new }
        let added = SecItemAdd(attributes as CFDictionary, nil)
        if added == errSecSuccess { return candidate }
        if added == errSecDuplicateItem, let existing = try read() { return existing }
        throw Failure.keychain(added)
    }

    private func read() throws -> Data? {
        let attributes = query.merging([
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]) { _, new in new }
        var result: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Failure.keychain(status) }
        guard let bytes = result as? Data, bytes.count == 32 else { throw Failure.invalidKey }
        return bytes
    }

    enum Failure: Error {
        case invalidKey
        case keychain(OSStatus)
    }
}
