import Foundation
import Security

enum SigningKeychainError: Error {
    case blocked(String)
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("SIGNING_KEYCHAIN_BLOCKED=\(message)\n".utf8))
    exit(2)
}

func loginKeychain() throws -> SecKeychain {
    let loginPath = NSString(string: "~/Library/Keychains/login.keychain-db").expandingTildeInPath
    var keychain: SecKeychain?
    guard SecKeychainOpen(loginPath, &keychain) == errSecSuccess, let opened = keychain else {
        throw SigningKeychainError.blocked("login-keychain-unavailable")
    }
    return opened
}

func password(service: String, account: String, login: SecKeychain) throws -> Data? {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecUseKeychain as String: login,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
        throw SigningKeychainError.blocked("login-keychain-read")
    }
    return data
}

func storePassword(_ data: Data, service: String, account: String, login: SecKeychain) throws {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecUseKeychain as String: login
    ]
    let attributes: [String: Any] = [
        kSecValueData as String: data,
        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlocked
    ]
    let status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
    guard status == errSecSuccess else {
        throw SigningKeychainError.blocked("login-keychain-write")
    }
}

func generatedPassword() throws -> Data {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
        throw SigningKeychainError.blocked("password-generation")
    }
    return Data(bytes).base64EncodedData()
}

func existingKeychain(at path: String, password: Data) throws -> SecKeychain {
    var keychain: SecKeychain?
    let openStatus = SecKeychainOpen(path, &keychain)
    guard openStatus == errSecSuccess, let opened = keychain else {
        throw SigningKeychainError.blocked("keychain-missing-or-corrupt-recovery-required")
    }
    let unlockStatus = password.withUnsafeBytes {
        SecKeychainUnlock(opened, UInt32(password.count), $0.baseAddress, true)
    }
    guard unlockStatus == errSecSuccess else {
        throw SigningKeychainError.blocked("keychain-password-mismatch-recovery-required")
    }
    return opened
}

func createKeychain(at path: String, password: Data) throws -> SecKeychain {
    try FileManager.default.createDirectory(
        at: URL(fileURLWithPath: path).deletingLastPathComponent(),
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )
    var keychain: SecKeychain?
    let status = password.withUnsafeBytes {
        SecKeychainCreate(path, UInt32(password.count), $0.baseAddress, false, nil, &keychain)
    }
    guard status == errSecSuccess, let created = keychain else {
        throw SigningKeychainError.blocked("keychain-create")
    }
    return created
}

var args = Array(CommandLine.arguments.dropFirst())
func value(_ name: String) -> String {
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { fail("invalid-arguments") }
    return args[index + 1]
}

let keychainPath = value("--keychain-path")
let service = value("--service-id")
let account = value("--account-id")
guard let timeout = UInt32(value("--timeout")) else { fail("invalid-timeout") }
let commandIndex = args.firstIndex(of: "--")
var command = commandIndex.map { Array(args.dropFirst($0 + 1)) } ?? []
if args.contains("--inject-keychain-option") && !command.isEmpty {
    command.append("keychain_path:\(keychainPath)")
}
if let index = args.firstIndex(of: "--inject-safe-handoff"),
   index + 2 < args.count,
   !command.isEmpty {
    command.append("keychain_service_identifier:\(args[index + 1])")
    command.append("keychain_path_fingerprint:\(args[index + 2])")
}

// Refuse aliases and repository-relative ambiguity before touching Security APIs.
if (try? URL(fileURLWithPath: keychainPath).resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true {
    fail("symlink-path")
}
var component = URL(fileURLWithPath: keychainPath).deletingLastPathComponent()
while component.path != "/" {
    if (try? component.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true {
        fail("symlink-path")
    }
    component.deleteLastPathComponent()
}

do {
    let login = try loginKeychain()
    let fileExists = FileManager.default.fileExists(atPath: keychainPath)
    let savedPassword = try password(service: service, account: account, login: login)
    if fileExists != (savedPassword != nil) {
        fail(fileExists ? "password-missing-recovery-required" : "keychain-missing-recovery-required")
    }

    let secret: Data
    let signingKeychain: SecKeychain
    if let retained = savedPassword {
        secret = retained
        signingKeychain = try existingKeychain(at: keychainPath, password: retained)
    } else {
        secret = try generatedPassword()
        signingKeychain = try createKeychain(at: keychainPath, password: secret)
        do {
            try storePassword(secret, service: service, account: account, login: login)
        } catch {
            // A newly-created keychain without its matching retained password is unusable.
            // Preserve it for explicit recovery rather than silently deleting evidence.
            throw error
        }
    }

    var settings = SecKeychainSettings(version: UInt32(SEC_KEYCHAIN_SETTINGS_VERS1), lockOnSleep: true, useLockInterval: true, lockInterval: timeout)
    guard SecKeychainSetSettings(signingKeychain, &settings) == errSecSuccess else {
        throw SigningKeychainError.blocked("keychain-timeout")
    }

    var originalRef: CFArray?
    guard SecKeychainCopySearchList(&originalRef) == errSecSuccess,
          let original = originalRef as? [SecKeychain] else {
        throw SigningKeychainError.blocked("search-list-read")
    }
    var restored = false
    defer {
        if !restored {
            SecKeychainSetSearchList(original as CFArray)
        }
    }
    let updated = [signingKeychain] + original.filter { $0 !== signingKeychain }
    guard SecKeychainSetSearchList(updated as CFArray) == errSecSuccess else {
        throw SigningKeychainError.blocked("search-list-update")
    }

    var status: Int32 = 0
    if let executable = command.first {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = Array(command.dropFirst())
        process.standardInput = FileHandle.standardInput
        process.standardOutput = FileHandle.standardOutput
        process.standardError = FileHandle.standardError
        try process.run()
        process.waitUntilExit()
        status = process.terminationStatus
    }
    guard SecKeychainSetSearchList(original as CFArray) == errSecSuccess else {
        throw SigningKeychainError.blocked("search-list-restore")
    }
    restored = true
    exit(status)
} catch let SigningKeychainError.blocked(reason) {
    fail(reason)
} catch {
    fail("secure-operation")
}
