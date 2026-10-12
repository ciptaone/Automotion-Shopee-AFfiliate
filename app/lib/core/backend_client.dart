import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'secure_store.dart';
import '../models/api_models.dart';

/// Typed client for the Autopilot backend.
///
/// Responsibilities:
///  - exchange the operator-issued install key for a session token,
///  - attach the Bearer token to authenticated calls,
///  - transparently refresh the token ONCE on 401 (no infinite retry loops),
///  - bound every request with a timeout,
///  - retry idempotent GETs exactly once on a network fault,
///  - surface typed exceptions instead of raw socket errors.
///
/// The client never logs or persists a secret other than the session token in
/// platform-secure storage, and it holds NO provider credentials itself.
class BackendClient {
  BackendClient({
    required this.baseUrl,
    http.Client? httpClient,
    this.requestTimeout = const Duration(seconds: 12),
    this.maxGetAttempts = 2,
  }) : _http = httpClient ?? http.Client();

  final String baseUrl;
  final http.Client _http;

  /// Upper bound applied to every HTTP call so a dead backend cannot hang a screen.
  final Duration requestTimeout;

  /// Total attempts for idempotent GETs on a network fault (1 = no retry).
  final int maxGetAttempts;

  /// Resolved on every call so tests can swap the backing store safely.
  static SecureStore get _secure => SecureStore.instance;

  /// Headers used for every request. Nothing secret is ever added here beyond
  /// the per-request Authorization header.
  Map<String, String> get _jsonHeaders => const {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      };

  /* ---------------------------------------------------------------------- */
  /*  Public surface                                                         */
  /* ---------------------------------------------------------------------- */

  /// GET a public endpoint (no auth header).
  Future<Map<String, dynamic>> getPublic(String path) async {
    final response = await _attempt(
      () => _http.get(Uri.parse('$baseUrl$path'), headers: _jsonHeaders),
      retry: true,
    );
    return _decode(response, () => <String, dynamic>{});
  }

  /// GET an authenticated endpoint, refreshing the token once if it has expired.
  Future<Map<String, dynamic>> getAuthed(String path) =>
      _authed('GET', path, retry: true);

  /// PUT an authenticated endpoint (settings updates).
  Future<Map<String, dynamic>> putAuthed(String path, Map<String, dynamic> body) =>
      _authed('PUT', path, body: body);

  /// POST an authenticated endpoint (automation control).
  Future<Map<String, dynamic>> postAuthed(String path, Map<String, dynamic> body) =>
      _authed('POST', path, body: body);

  /// Exchange the stored install key for a fresh session token.
  Future<TokenResponse> redeemInstallKey(String installKey) async {
    final uri = Uri.parse('$baseUrl/v1/auth/token');
    final response = await _attempt(
      () => _http.post(
        uri,
        headers: _jsonHeaders,
        body: jsonEncode(<String, dynamic>{
          'installKey': installKey,
          'deviceLabel': 'android-apk',
        }),
      ),
      retry: false, // never replay a credential-bearing request automatically
    );
    final body = _decode(response, () => <String, dynamic>{});
    final token = TokenResponse.fromJson(body);
    if (token.accessToken.isEmpty) {
      throw const AuthException('Backend did not return an access token');
    }
    await _secure.saveSessionToken(token.accessToken);
    return token;
  }

  /// Cheap connectivity probe used by the dashboard / integrations screens.
  /// Returns `true` only for a well-formed 2xx health payload.
  Future<bool> ping() async {
    try {
      final body = await getPublic('/health');
      return body['status'] is String;
    } on ApiException {
      return false;
    }
  }

  Future<void> signOut() => _secure.clearSession();

  /* ---------------------------------------------------------------------- */
  /*  Internals                                                              */
  /* ---------------------------------------------------------------------- */

  Future<Map<String, dynamic>> _authed(
    String method,
    String path, {
    Map<String, dynamic>? body,
    bool retry = false,
  }) async {
    var token = await _secure.readSessionToken();
    if (token == null || token.isEmpty) {
      throw const AuthException('Not signed in');
    }

    var response = await _send(method, path, token: token, body: body, retry: retry);

    if (response.statusCode == 401) {
      // ONE transparent refresh. If that fails we stop — no retry loop.
      token = await _refreshSession();
      if (token == null) {
        throw const AuthException('Session expired');
      }
      response = await _send(method, path, token: token, body: body, retry: retry);
    }

    return _decode(response, () => <String, dynamic>{});
  }

  Future<http.Response> _send(
    String method,
    String path, {
    String? token,
    Map<String, dynamic>? body,
    bool retry = false,
  }) {
    final uri = Uri.parse('$baseUrl$path');
    final headers = <String, String>{..._jsonHeaders};
    if (token != null) {
      headers['Authorization'] = 'Bearer $token';
    }

    Future<http.Response> call() {
      switch (method) {
        case 'PUT':
          return _http.put(uri, headers: headers, body: jsonEncode(body ?? const {}));
        case 'POST':
          return _http.post(uri, headers: headers, body: jsonEncode(body ?? const {}));
        case 'GET':
        default:
          return _http.get(uri, headers: headers);
      }
    }

    return _attempt(call, retry: retry);
  }

  /// Runs [call] with a timeout, mapping transport faults to [NetworkException].
  /// Idempotent requests are retried exactly once when [retry] is true.
  Future<http.Response> _attempt(
    Future<http.Response> Function() call, {
    required bool retry,
  }) async {
    final maxAttempts = retry ? maxGetAttempts : 1;
    for (var attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await call().timeout(requestTimeout);
      } on TimeoutException {
        if (attempt >= maxAttempts) {
          throw const NetworkException('The backend did not respond in time.');
        }
      } on SocketException {
        if (attempt >= maxAttempts) {
          throw const NetworkException('Cannot reach the backend. Check the connection.');
        }
      } on http.ClientException catch (e) {
        if (attempt >= maxAttempts) {
          throw NetworkException(e.message);
        }
      }
    }
    throw const NetworkException('Cannot reach the backend.');
  }

  /// Try to re-authenticate using the stored install key. Returns null on failure.
  Future<String?> _refreshSession() async {
    final installKey = await _secure.readInstallKey();
    if (installKey == null || installKey.isEmpty) return null;
    try {
      await redeemInstallKey(installKey);
      return _secure.readSessionToken();
    } on ApiException {
      return null;
    }
  }

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
      final message = error['message'] as String? ?? 'Request failed';
      if (response.statusCode == 401 || code == 'UNAUTHENTICATED') {
        throw AuthException(message);
      }
      final issues = _issueMessages(error['issues']);
      if (response.statusCode >= 500) {
        throw ServerException('Backend error (HTTP ${response.statusCode})');
      }
      throw ServerException(
        issues.isEmpty ? message : '$message\n${issues.join('\n')}',
        issues: issues,
        code: code,
      );
    }

    if (response.statusCode >= 500) {
      throw ServerException('Backend error (HTTP ${response.statusCode})');
    }
    return fallback();
  }

  List<String> _issueMessages(dynamic raw) {
    if (raw is! List) return const [];
    return raw
        .whereType<Map<String, dynamic>>()
        .map((issue) {
          final path = issue['path'] ?? issue['rule'];
          final message = issue['message'] as String? ?? 'invalid';
          return path == null ? message : '$path: $message';
        })
        .toList();
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

/// Transport-level failure: offline, DNS failure, timeout, connection refused.
final class NetworkException extends ApiException {
  const NetworkException(super.message);
}

final class ServerException extends ApiException {
  const ServerException(
    super.message, {
    this.issues = const [],
    this.code = '',
  });

  /// Machine-readable backend error code (e.g. `INVALID_SETTINGS`).
  final String code;

  /// Per-field validation issues, when the backend provided them.
  final List<String> issues;

  bool get isValidation => issues.isNotEmpty || code == 'INVALID_SETTINGS';
}
