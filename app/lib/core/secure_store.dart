import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Thin wrapper around platform-secure credential storage.
///
/// Stores:
///  - the operator-issued install key (used once to obtain a session token),
///  - the backend-issued JWT session token.
///
/// Tokens are stored in the Android Keystore-backed secure storage so they are
/// not readable from backups or by root-inspection of plain SharedPreferences.
class SecureStore {
  SecureStore._();
  static final SecureStore instance = SecureStore._();

  static const _storage = FlutterSecureStorage();

  static const _kInstallKey = 'install_key';
  static const _kSessionToken = 'session_token';

  Future<bool> hasSession() async {
    final token = await _storage.read(key: _kSessionToken);
    return token != null && token.isNotEmpty;
  }

  Future<String?> readInstallKey() => _storage.read(key: _kInstallKey);

  Future<void> saveInstallKey(String key) =>
      _storage.write(key: _kInstallKey, value: key.trim());

  Future<String?> readSessionToken() => _storage.read(key: _kSessionToken);

  Future<void> saveSessionToken(String token) =>
      _storage.write(key: _kSessionToken, value: token);

  Future<void> clearSession() => _storage.delete(key: _kSessionToken);

  Future<void> clearAll() => _storage.deleteAll();
}
