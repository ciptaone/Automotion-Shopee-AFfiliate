import 'dart:convert';

import 'package:http/http.dart' as http;

import 'secure_store.dart';
import '../models/api_models.dart';

/// Typed client for the Autopilot backend.
///
/// Responsibilities:
///  - exchange the operator-issued install key for a session token,
///  - attach the Bearer token to authenticated calls,
///  - transparently refresh the token once on 401,
///  - surface typed models instead of raw maps.
///
/// The client never logs or persists a secret other than the session token in
/// platform-secure storage, and it holds NO provider credentials itself.
class BackendClient {
  BackendClient({required this.baseUrl, http.Client? httpClient})
      : _http = httpClient ?? http.Client();

  final String baseUrl;
  final http.Client _http;

  static final _secure = SecureStore.instance;

  /// GET a public endpoint (no auth header).
  Future<Map<String, dynamic>> getPublic(String path) async {
    final uri = Uri.parse('$baseUrl$path');
    final response = await _http.get(uri, headers: _jsonHeaders());
    return _decode(response, () => <String, dynamic>{});
  }

  /// GET an authenticated endpoint, refreshing the token once if it has expired.
  Future<Map<String, dynamic>> getAuthed(String path) async {
    var token = await _secure.readSessionToken();
    if (token == null || token.isEmpty) {
      throw const AuthException('Not signed in');
    }

    var uri = Uri.parse('$baseUrl$path');
    var response = await _http.get(uri, headers: _authHeaders(token));

    if (response.statusCode == 401) {
      // One transparent retry after re-establishing the session.
      token = await _refreshSession();
      if (token == null) {
        throw const AuthException('Session expired');
      }
      response = await _http.get(uri, headers: _authHeaders(token));
    }

    return _decode(response, () => <String, dynamic>{});
  }

  /// Exchange the stored install key for a fresh session token.
  Future<TokenResponse> redeemInstallKey(String installKey) async {
    final uri = Uri.parse('$baseUrl/v1/auth/token');
    final response = await _http.post(
      uri,
      headers: _jsonHeaders(),
      body: jsonEncode({'installKey': installKey}),
    );
    final body = _decode(response, () => <String, dynamic>{});
    final token = TokenResponse.fromJson(body);
    if (token.accessToken.isEmpty) {
      throw const AuthException('Backend did not return an access token');
    }
    await _secure.saveSessionToken(token.accessToken);
    return token;
  }

  /// Try to re-authenticate using the stored install key. Returns null on failure.
  Future<String?> _refreshSession() async {
    final installKey = await _secure.readInstallKey();
    if (installKey == null || installKey.isEmpty) return null;
    try {
      await redeemInstallKey(installKey);
      return _secure.readSessionToken();
    } catch (_) {
      return null;
    }
  }

  Future<void> signOut() => _secure.clearSession();

  /* ---------------------------------------------------------------------- */

  Map<String, String> _jsonHeaders() => const {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      };

  Map<String, String> _authHeaders(String token) => {
        ..._jsonHeaders(),
        'Authorization': 'Bearer $token',
      };

  Map<String, dynamic> _decode(
    http.Response response,
    Map<String, dynamic> Function() fallback,
  ) {
    final text = response.body;
    Map<String, dynamic> json;
    try {
      final decoded = text.isEmpty ? <String, dynamic>{} : jsonDecode(text);
      json = decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
    } catch (_) {
      throw ServerException('Backend returned a malformed response '
          '(HTTP ${response.statusCode})');
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return json;
    }

    final error = json['error'];
    if (error is Map<String, dynamic>) {
      final code = error['code'] as String? ?? '';
      if (response.statusCode == 401 || code == 'UNAUTHENTICATED') {
        throw AuthException(error['message'] as String? ?? 'Authentication failed');
      }
      throw ServerException(error['message'] as String? ?? 'Request failed');
    }

    if (response.statusCode >= 500) {
      throw ServerException('Backend error (HTTP ${response.statusCode})');
    }
    return fallback();
  }
}

/* -------------------------------------------------------------------------- */
/*  Typed exceptions                                                          */
/* -------------------------------------------------------------------------- */

/// Base class for client-side failures.
sealed class ApiException implements Exception {
  const ApiException(this.message);
  final String message;
  @override
  String toString() => message;
}

final class AuthException extends ApiException {
  const AuthException(super.message);
}

final class ServerException extends ApiException {
  const ServerException(super.message);
}
