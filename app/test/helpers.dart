import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shopee_affiliate_autopilot/core/autopilot_api.dart';
import 'package:shopee_affiliate_autopilot/core/backend_client.dart';
import 'package:shopee_affiliate_autopilot/core/secure_store.dart';

/// Shared test helpers: a deterministic fake backend, fixture payloads mirroring
/// the backend contract, and pump helpers that never open a real socket.

const String kTestToken = 'header.payload.signature';

/// Install an in-memory credential store and seed a session token, so
/// authenticated calls work without touching platform channels.
Future<void> seedSession() async {
  SecureStore.debugOverrideStore(MemoryKeyValueStore());
  await SecureStore.instance.saveSessionToken(kTestToken);
  await SecureStore.instance.saveInstallKey('install-key-for-tests');
}

/// Wrap a handler-based [MockClient] into the typed API facade.
AutopilotApi apiFrom(http.Client client) => AutopilotApi(
      BackendClient(
        baseUrl: 'http://backend.test',
        httpClient: client,
        requestTimeout: const Duration(seconds: 5),
      ),
    );

/// Pump a few frames so async fixture responses settle (no infinite spinner).
Future<void> settle(WidgetTester tester, {int frames = 8}) async {
  for (var i = 0; i < frames; i += 1) {
    await tester.pump(const Duration(milliseconds: 40));
  }
}

/// Standard test surface.
Widget appSurface(Widget child) => MaterialApp(
      home: child,
      theme: ThemeData(useMaterial3: true),
    );

/// Pump [child] on a tall screen so every card is built (nothing is scrolled
/// out of the viewport, which would keep `find.text` from matching).
Future<void> pumpSurface(WidgetTester tester, Widget child) async {
  tester.view.physicalSize = const Size(1080, 3200);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(appSurface(child));
}

http.Response jsonResponse(Map<String, dynamic> body, {int status = 200}) => http.Response(
      jsonEncode(body),
      status,
      headers: {'content-type': 'application/json'},
    );

http.Response errorResponse(int status, String code, String message,
    {List<dynamic>? issues}) {
  final error = <String, dynamic>{'code': code, 'message': message};
  if (issues != null) {
    error['issues'] = issues;
  }
  return jsonResponse({'error': error}, status: status);
}

/* -------------------------------------------------------------------------- */
/*  Fixtures (mirror backend/src/automation/fixtures.ts + server routes)      */
/* -------------------------------------------------------------------------- */

Map<String, dynamic> automationStatusFixture({
  String state = 'running',
  bool degraded = false,
  List<String> degradedReasons = const [],
  int slotsScheduled = 24,
  int slotsUsed = 6,
  int succeeded = 4,
  int failed = 1,
  int retrying = 1,
  List<Map<String, dynamic>> activity = const [
    {
      'id': 'job-1',
      'kind': 'publish',
      'status': 'succeeded',
      'uniqueKey': '2026-10-12#01',
      'scheduledFor': '2026-10-11T17:00:00.000Z',
      'attempts': 1,
      'maxAttempts': 3,
      'lastError': null,
      'updatedAt': '2026-10-11T17:01:00.000Z',
    },
  ],
}) =>
    {
      'state': state,
      'degraded': degraded,
      'degradedReasons': degradedReasons,
      'timezone': 'Asia/Jakarta',
      'today': '2026-10-12',
      'slotsScheduled': slotsScheduled,
      'slotsUsed': slotsUsed,
      'slotsRemaining': slotsScheduled - slotsUsed,
      'publications': {
        'succeeded': succeeded,
        'failed': failed,
        'retrying': retrying,
        'source': 'job_queue',
      },
      'latestContent': null,
      'latestContentNote':
          'No content has been generated yet: the generation pipeline is not implemented.',
      'recentActivity': activity,
      'recentActivitySource': 'job_queue',
      'serverTime': '2026-10-12T03:00:00.000Z',
    };

Map<String, dynamic> settingsFixture({
  int intervalMinutes = 60,
  int maxSlotsPerDay = 24,
  bool facebookEnabled = true,
  bool threadsEnabled = true,
  String imageCountPolicy = 'random_1_or_2',
  bool telegramEnabled = true,
  String state = 'paused',
  String storageKind = 'file',
  String? warning,
}) =>
    {
      'settings': {
        'intervalMinutes': intervalMinutes,
        'maxSlotsPerDay': maxSlotsPerDay,
        'facebookEnabled': facebookEnabled,
        'threadsEnabled': threadsEnabled,
        'imageCountPolicy': imageCountPolicy,
        'telegramNotificationsEnabled': telegramEnabled,
        'automationState': state,
      },
      'defaults': {
        'intervalMinutes': 60,
        'maxSlotsPerDay': 24,
        'facebookEnabled': true,
        'threadsEnabled': true,
        'imageCountPolicy': 'random_1_or_2',
        'telegramNotificationsEnabled': true,
        'automationState': 'paused',
      },
      'storage': {'kind': storageKind},
      'warning': warning,
      'constraints': {
        'minIntervalMinutes': 15,
        'maxIntervalMinutes': 720,
        'maxSlotsPerDay': 24,
        'imageCountPolicies': ['random_1_or_2', 'one', 'two'],
      },
      'controls': ['start', 'pause', 'resume'],
      'note': 'Settings are persisted by the backend.',
    };

Map<String, dynamic> previewFixture({
  int imageCount = 2,
  String policy = 'random_1_or_2',
  String slotKey = '2026-10-12#07',
  bool validationPassed = true,
  bool threadsEnabled = true,
}) =>
    {
      'source': 'fixture',
      'note': 'Fixture content — the generation pipeline is not implemented yet.',
      'slotKey': slotKey,
      'imageCountPolicy': policy,
      'imageCount': imageCount,
      'imageCountSource': 'fixture_placeholder',
      'imageCountNote': 'Placeholder selection derived from the slot key.',
      'imageCountShared': true,
      'imageCountStable': true,
      'product': {
        'name': 'Tumbler Stainless 500 ml (contoh fixture)',
        'affiliateUrl': 'https://shopee.co.id/contoh-tumbler-fixture?afrom=FIXTURE',
        'source': 'fixture',
      },
      'caption': {
        'source': 'fixture',
        'fullText':
            'Lagi cari tumbler yang ringkas?\n\nCek detail dan ulasan pembeli di Shopee.\n'
                'Klik link di bawah untuk lihat harga terbaru.\n\n#tumbler #shopeeaffiliate\n'
                'https://shopee.co.id/contoh-tumbler-fixture?afrom=FIXTURE',
        'hashtags': ['#tumbler', '#shopeeaffiliate'],
      },
      'validation': {
        'source': 'real_validator_on_fixture_text',
        'passed': validationPassed,
        'blocking': validationPassed
            ? <Map<String, dynamic>>[]
            : [
                {
                  'rule': 'caption.affiliate_link_embedded',
                  'message': 'Affiliate URL does not appear verbatim in the caption.',
                }
              ],
        'warnings': [
          {'rule': 'caption.hashtag_minimum', 'message': 'Only two hashtags.'}
        ],
        'platformsChecked': threadsEnabled
            ? ['facebook_page', 'threads']
            : ['facebook_page'],
      },
      'platforms': {
        'facebook': {
          'enabled': true,
          'status': 'not_attempted',
          'url': null,
          'detail': '$imageCount image(s) reserved for this slot.',
        },
        'threads': {
          'enabled': threadsEnabled,
          'status': 'not_attempted',
          'url': null,
          'detail': threadsEnabled ? 'Publication not implemented yet.' : 'Disabled in settings.',
        },
      },
    };

Map<String, dynamic> historyFixture() => {
      'source': 'fixture',
      'note': 'Fixture history — sample records only.',
      'count': 3,
      'items': [
        {
          'source': 'fixture',
          'id': 'fixture-1',
          'slotKey': 'fixture-A',
          'publishedAt': '2026-10-12T02:00:00.000Z',
          'productName': 'Tumbler Stainless 500 ml (contoh fixture)',
          'imageCount': 2,
          'facebook': {
            'status': 'published',
            'url': 'https://www.facebook.com/permalink.php?fixture=1',
            'error': null,
          },
          'threads': {
            'status': 'published',
            'url': 'https://www.threads.net/@fixture/post/FIXTURE1',
            'error': null,
          },
          'retry': {'status': 'none', 'attempts': 0, 'maxAttempts': 3},
        },
        {
          'source': 'fixture',
          'id': 'fixture-2',
          'slotKey': 'fixture-B',
          'publishedAt': '2026-10-12T01:00:00.000Z',
          'productName': 'Tumbler Stainless 500 ml (contoh fixture)',
          'imageCount': 1,
          'facebook': {
            'status': 'published',
            'url': 'https://www.facebook.com/permalink.php?fixture=2',
            'error': null,
          },
          'threads': {
            'status': 'failed',
            'url': null,
            'error': 'Threads container was not published (sample error).',
          },
          'retry': {'status': 'pending', 'attempts': 1, 'maxAttempts': 3},
        },
        {
          'source': 'fixture',
          'id': 'fixture-3',
          'slotKey': 'fixture-C',
          'publishedAt': '2026-10-12T00:00:00.000Z',
          'productName': 'Tumbler Stainless 500 ml (contoh fixture)',
          'imageCount': 2,
          'facebook': {
            'status': 'failed',
            'url': null,
            'error': 'Page token rejected (sample error).',
          },
          'threads': {'status': 'not_attempted', 'url': null, 'error': null},
          'retry': {'status': 'exhausted', 'attempts': 3, 'maxAttempts': 3},
        },
      ],
    };

Map<String, dynamic> integrationsFixture({
  String facebookHealth = 'not_tested',
  String threadsHealth = 'disconnected',
}) =>
    {
      'integrations': [
        {
          'service': 'facebook_page',
          'configured': facebookHealth != 'disconnected',
          'mode': facebookHealth == 'disconnected' ? 'disabled' : 'live_ready',
          'detail': 'FACEBOOK_PAGE_ID not set — publisher disabled.',
          'health': facebookHealth,
          'healthDetail': 'Configured but not tested live.',
        },
        {
          'service': 'threads',
          'configured': threadsHealth != 'disconnected',
          'mode': threadsHealth == 'disconnected' ? 'disabled' : 'live_ready',
          'detail': 'THREADS_USER_ID not set.',
          'health': threadsHealth,
          'healthDetail': 'Not configured — no credentials present.',
        },
        {
          'service': 'telegram',
          'configured': false,
          'mode': 'mock',
          'detail': 'In-memory transport.',
          'health': 'disconnected',
          'healthDetail': 'Not configured — no credentials present.',
        },
        {
          'service': 'shopee_feed',
          'configured': true,
          'mode': 'blocked',
          'detail': 'Upload-only ingestion.',
          'health': 'blocked',
          'healthDetail': 'Blocked: no official live-feed contract is available.',
        },
        {
          'service': 'ai_image',
          'configured': true,
          'mode': 'mock',
          'detail': 'Deterministic mock.',
          'health': 'not_tested',
          'healthDetail': 'Deterministic mock only.',
        },
      ],
      'healthLegend': {
        'connected': 'Live credentials present AND verified.',
        'blocked': 'A required prerequisite is missing.',
        'not_tested': 'No live call has been verified.',
        'disconnected': 'Nothing is configured.',
      },
      'note': 'No secret values are exposed.',
    };
