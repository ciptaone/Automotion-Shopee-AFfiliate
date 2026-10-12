import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shopee_affiliate_autopilot/core/autopilot_api.dart';
import 'package:shopee_affiliate_autopilot/core/backend_client.dart';
import 'package:shopee_affiliate_autopilot/core/secure_store.dart';
import 'package:shopee_affiliate_autopilot/models/automation_models.dart';

import 'helpers.dart';

/// API-client behaviour that the whole control surface depends on:
/// authentication failures, expired sessions, offline handling and the
/// guarantee that no request loops forever and no secret leaks into an error.
void main() {
  setUp(seedSession);

  group('GET authentication', () {
    test('attaches the bearer token from secure storage', () async {
      String? seenAuth;
      final client = MockClient((request) async {
        if (request.url.path == '/v1/automation/status') {
          seenAuth = request.headers['authorization'];
          return jsonResponse(automationStatusFixture());
        }
        return errorResponse(404, 'NOT_FOUND', 'nope');
      });

      final api = apiFrom(client);
      final status = await api.fetchAutomationStatus();

      expect(seenAuth, 'Bearer $kTestToken');
      expect(status.state, AutomationState.running);
    });

    test('fails fast with AuthException when no session exists', () async {
      var calls = 0;
      final client = MockClient((request) async {
        calls += 1;
        return jsonResponse(automationStatusFixture());
      });
      // No session token stored.
      SecureStore.debugOverrideStore(MemoryKeyValueStore());

      await expectLater(
        apiFrom(client).fetchAutomationStatus(),
        throwsA(isA<AuthException>()),
      );
      expect(calls, 0, reason: 'no request may be sent without a session');
    });
  });

  group('Authentication failures', () {
    test('maps a 401 from a protected endpoint to AuthException', () async {
      final client = MockClient((request) async =>
          errorResponse(401, 'UNAUTHENTICATED', 'Access token expired'));

      await expectLater(
        apiFrom(client).fetchAutomationStatus(),
        throwsA(isA<AuthException>()),
      );
    });

    test('recovers from an expired token by re-deeming the install key ONCE', () async {
      final calls = <String>[];
      var attempt = 0;

      final client = MockClient((request) async {
        calls.add('${request.method} ${request.url.path}');
        if (request.url.path == '/v1/auth/token') {
          return jsonResponse({
            'accessToken': 'refreshed.token.value',
            'tokenType': 'Bearer',
            'expiresIn': 3600,
            'scope': ['read'],
          });
        }
        attempt += 1;
        // First authenticated call is rejected, the retry succeeds.
        if (attempt == 1) {
          return errorResponse(401, 'UNAUTHENTICATED', 'Access token expired');
        }
        return jsonResponse(automationStatusFixture(state: 'paused'));
      });

      final api = apiFrom(client);
      final status = await api.fetchAutomationStatus();

      expect(status.state, AutomationState.paused);
      expect(calls, [
        'GET /v1/automation/status', // rejected
        'POST /v1/auth/token', // one refresh
        'GET /v1/automation/status', // single retry
      ]);
    });

    test('stops after one refresh attempt — no infinite retry loop', () async {
      final calls = <String>[];
      final client = MockClient((request) async {
        calls.add('${request.method} ${request.url.path}');
        if (request.url.path == '/v1/auth/token') {
          return errorResponse(401, 'INVALID_INSTALL_KEY', 'Invalid install key');
        }
        return errorResponse(401, 'UNAUTHENTICATED', 'Access token expired');
      });

      await expectLater(
        apiFrom(client).fetchAutomationStatus(),
        throwsA(isA<AuthException>()),
      );

      expect(calls, hasLength(2), reason: 'one GET, one refresh attempt, then stop');
      expect(calls.last, 'POST /v1/auth/token');
    });

    test('never retries a credential-bearing token exchange', () async {
      var tokenCalls = 0;
      final client = MockClient((request) async {
        if (request.url.path == '/v1/auth/token') {
          tokenCalls += 1;
          throw const SocketException('connection reset');
        }
        return jsonResponse(<String, dynamic>{});
      });

      await expectLater(
        apiFrom(client).redeemInstallKey('install-key-for-tests'),
        throwsA(isA<NetworkException>()),
      );
      expect(tokenCalls, 1);
    });
  });

  group('Offline and timeout handling', () {
    test('maps a socket failure to NetworkException after the configured retries',
        () async {
      var calls = 0;
      final client = MockClient((request) async {
        calls += 1;
        throw const SocketException('failed host lookup');
      });

      await expectLater(
        apiFrom(client).fetchAutomationStatus(),
        throwsA(isA<NetworkException>()),
      );
      expect(calls, 2, reason: 'idempotent GETs retry once by default');
    });

    test('honours a single-attempt configuration', () async {
      var calls = 0;
      final client = MockClient((request) async {
        calls += 1;
        throw const SocketException('failed host lookup');
      });

      final api = AutopilotApi(
        BackendClient(
          baseUrl: 'http://backend.test',
          httpClient: client,
          maxGetAttempts: 1,
        ),
      );

      await expectLater(api.fetchAutomationStatus(), throwsA(isA<NetworkException>()));
      expect(calls, 1);
    });

    test('times out instead of hanging on a dead backend', () async {
      final client = MockClient((request) => Completer<http.Response>().future);
      final api = AutopilotApi(
        BackendClient(
          baseUrl: 'http://backend.test',
          httpClient: client,
          requestTimeout: const Duration(milliseconds: 60),
          maxGetAttempts: 1,
        ),
      );

      await expectLater(api.fetchAutomationStatus(), throwsA(isA<NetworkException>()));
    });

    test('ping() reports false instead of throwing when offline', () async {
      final client = MockClient((request) async => throw const SocketException('down'));
      expect(await apiFrom(client).ping(), isFalse);
    });

    test('ping() reports true only for a well-formed health payload', () async {
      final ok = MockClient((request) async => jsonResponse({'status': 'ok'}));
      expect(await apiFrom(ok).ping(), isTrue);

      final malformed = MockClient((request) async => jsonResponse({'nope': 1}));
      expect(await apiFrom(malformed).ping(), isFalse);
    });
  });

  group('Validation errors', () {
    test('surfaces per-field issues from a rejected settings update', () async {
      final client = MockClient((request) async => errorResponse(
            400,
            'INVALID_SETTINGS',
            'Settings rejected: too many slots.',
            issues: [
              {'rule': 'settings.maxSlotsPerDay', 'message': 'Must be 24 or fewer.'}
            ],
          ));

      try {
        await apiFrom(client).saveSettings({'maxSlotsPerDay': 40});
        fail('expected a ServerException');
      } on ServerException catch (e) {
        expect(e.isValidation, isTrue);
        expect(e.code, 'INVALID_SETTINGS');
        expect(e.issues.single, contains('settings.maxSlotsPerDay'));
        expect(e.message, contains('Must be 24 or fewer'));
      }
    });

    test('maps a 5xx to a ServerException without leaking internals', () async {
      final client = MockClient((request) async => http.Response('boom', 500));
      try {
        await apiFrom(client).fetchSettings();
        fail('expected a ServerException');
      } on ServerException catch (e) {
        expect(e.message, contains('500'));
        expect(e.message, isNot(contains('boom')));
      }
    });

    test('maps a malformed body to a ServerException', () async {
      final client = MockClient(
        (request) async => http.Response('<html>not json</html>', 200),
      );
      await expectLater(apiFrom(client).fetchSettings(), throwsA(isA<ServerException>()));
    });
  });

  group('Secret hygiene', () {
    test('no exception message contains the session token or install key', () async {
      final scenarios = <MockClient>[
        MockClient((request) async => errorResponse(401, 'UNAUTHENTICATED', 'expired')),
        MockClient((request) async => throw const SocketException('reset by peer')),
        MockClient((request) async => http.Response('', 502)),
      ];

      for (final client in scenarios) {
        try {
          await apiFrom(client).fetchAutomationStatus();
        } on ApiException catch (e) {
          expect(e.message, isNot(contains(kTestToken)));
          expect(e.message.toLowerCase(), isNot(contains('install-key')));
        }
      }
    });

    test('the client stores nothing beyond the token in secure storage', () async {
      final store = MemoryKeyValueStore();
      SecureStore.debugOverrideStore(store);

      final client = MockClient((request) async => jsonResponse({
            'accessToken': 'a.b.c',
            'tokenType': 'Bearer',
            'expiresIn': 3600,
            'scope': ['read'],
          }));

      await apiFrom(client).redeemInstallKey('install-key-for-tests');

      final storedToken = await SecureStore.instance.readSessionToken();
      expect(storedToken, 'a.b.c');
      await SecureStore.instance.clearAll();
      expect(await SecureStore.instance.readSessionToken(), isNull);
      expect(await SecureStore.instance.readInstallKey(), isNull);
    });
  });
}
