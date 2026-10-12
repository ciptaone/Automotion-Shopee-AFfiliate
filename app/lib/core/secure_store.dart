import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Storage abstraction so widget/unit tests never touch platform channels.
abstract class KeyValueStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
  Future<void> deleteAll();
}

/// Android Keystore-backed storage (the production implementation).
class SecureKeyValueStore implements KeyValueStore {
  const SecureKeyValueStore();

  static const FlutterSecureStorage _storage = FlutterSecureStorage();

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) => _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);

  @override
  Future<void> deleteAll() => _storage.deleteAll();
}

/// In-memory store for tests (no platform channels, no persistence).
class MemoryKeyValueStore implements KeyValueStore {
  final Map<String, String> _values = <String, String>{};

  @override
  Future<String?> read(String key) async => _values[key];

  @override
  Future<void> write(String key, String value) async {
    _values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    _values.remove(key);
  }

  @override
  Future<void> deleteAll() async {
    _values.clear();
  }
}

/// Thin wrapper around platform-secure credential storage.
///
/// Stores:
///  - the operator-issued install key (used once to obtain a session token),
///  - the backend-issued JWT session token.
///
/// Tokens are stored in the Android Keystore-backed secure storage so they are
/// not readable from backups or by root-inspection of plain SharedPreferences.
///
/// SECURITY: this is the ONLY place in the app that persists a credential, and
/// the only credential it can ever hold is the operator's install key plus the
/// backend session token. No Shopee / Meta / AI / storage secret exists here.
class SecureStore {
  SecureStore([KeyValueStore? store]) : _store = store ?? const SecureKeyValueStore();

  static SecureStore instance = SecureStore();

  /// Swap the backing store in tests. Never call this from production code.
  @visibleForTesting
  static void debugOverrideStore(KeyValueStore store) {
    instance = SecureStore(store);
  }

  /// Restore the platform-secure backing store.
  @visibleForTesting
  static void debugResetStore() {
    instance = SecureStore(const SecureKeyValueStore());
  }

  final KeyValueStore _store;

  static const String _kInstallKey = 'install_key';
  static const String _kSessionToken = 'session_token';

  Future<bool> hasSession() async {
    final token = await _store.read(_kSessionToken);
    return token != null && token.isNotEmpty;
  }

  Future<String?> readInstallKey() => _store.read(_kInstallKey);

  Future<void> saveInstallKey(String key) => _store.write(_kInstallKey, key.trim());

  Future<String?> readSessionToken() => _store.read(_kSessionToken);

  Future<void> saveSessionToken(String token) => _store.write(_kSessionToken, token);

  Future<void> clearSession() => _store.delete(_kSessionToken);

  Future<void> clearAll() => _store.deleteAll();
}
