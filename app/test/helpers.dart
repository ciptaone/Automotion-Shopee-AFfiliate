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
  String selectionMode = 'auto',
  List<String> selectedCategoryIds = const [],
  int dailyPostTarget = 4,
  double? dailyBudgetUsd,
  double? monthlyBudgetUsd,
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
        'selectionMode': selectionMode,
        'selectedCategoryIds': selectedCategoryIds,
        'dailyPostTarget': dailyPostTarget,
        'dailyBudgetUsd': dailyBudgetUsd,
        'monthlyBudgetUsd': monthlyBudgetUsd,
      },
      'defaults': {
        'intervalMinutes': 60,
        'maxSlotsPerDay': 24,
        'facebookEnabled': true,
        'threadsEnabled': true,
        'imageCountPolicy': 'random_1_or_2',
        'telegramNotificationsEnabled': true,
        'automationState': 'paused',
        'selectionMode': 'auto',
        'selectedCategoryIds': <String>[],
        'dailyPostTarget': 4,
        'dailyBudgetUsd': null,
        'monthlyBudgetUsd': null,
      },
      'storage': {'kind': storageKind},
      'warning': warning,
      'constraints': {
        'minIntervalMinutes': 15,
        'maxIntervalMinutes': 720,
        'maxSlotsPerDay': 24,
        'imageCountPolicies': ['random_1_or_2', 'one', 'two'],
        'selectionModes': ['auto', 'selected_categories'],
        'minDailyPostTarget': 3,
        'maxDailyPostTarget': 4,
        'defaultDailyPostTarget': 4,
        'postingWindows': [
          '06:00-07:00 WIB',
          '12:00-13:00 WIB',
          '16:00-17:00 WIB',
          '19:00-20:00 WIB',
        ],
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

/* -------------------------------------------------------------------------- */
/*  Part 3 fixtures: catalog categories, catalog status, pipeline preview     */
/* -------------------------------------------------------------------------- */

Map<String, dynamic> catalogCategoriesFixture({
  List<Map<String, dynamic>> categories = const [
    {'id': 'health-beauty', 'name': 'Health & Beauty', 'productCount': 3, 'eligibleProductCount': 2},
    {'id': 'home-living', 'name': 'Home & Living', 'productCount': 2, 'eligibleProductCount': 2},
  ],
  int total = 5,
}) =>
    {
      'categories': categories,
      'count': categories.length,
      'total': total,
      'note': 'Categories are derived from the actual imported catalog.',
    };

Map<String, dynamic> catalogStatusFixture({
  int total = 5,
  int eligible = 4,
  int categories = 2,
  String storage = 'file',
}) =>
    {
      'total': total,
      'eligible': eligible,
      'categories': categories,
      'storage': storage,
      'warning': null,
      'recentImports': [
        {
          'id': 'batch-1',
          'filename': 'feed.csv',
          'format': 'csv',
          'importedAt': '2026-10-12T02:00:00.000Z',
          'totalRows': 5,
          'newProducts': 5,
          'updatedProducts': 0,
          'rejected': 0,
          'duplicatesRemoved': 0,
          'urlDuplicatesSkipped': 0,
        },
      ],
    };

/// A REAL pipeline preview payload (source: `pipeline`), mirroring
/// `buildPipelinePreview` on the backend.
Map<String, dynamic> pipelinePreviewFixture({
  String stage = 'publish_ready',
  bool publishReady = true,
  int imageCount = 2,
  List<Map<String, dynamic>> blockers = const [],
  List<Map<String, dynamic>> images = const [],
  String imageProviderKind = 'mock',
  String captionProviderKind = 'mock',
  int attempts = 1,
  bool referenceAvailable = true,
  String? referenceUnavailableReason,
  bool editorialPassed = true,
  bool mandatoryEndingPresent = true,
  bool disclosurePresent = true,
  List<Map<String, dynamic>> editorialBlocking = const [],
  bool includeEditorial = true,
  bool includeImageQuality = true,
}) =>
    {
      'source': 'pipeline',
      'note': 'Generated by the content pipeline. Nothing has been published.',
      'slotKey': '2026-10-12#01',
      'imageCountPolicy': 'two',
      'imageCount': imageCount,
      'imageCountSource': 'pipeline_persisted',
      'stage': stage,
      'publishReady': publishReady,
      'attempts': attempts,
      'generationRunId': 'run-0001',
      'updatedAt': '2026-10-12T03:00:00.000Z',
      'providers': {
        'image': {'name': 'mock_image', 'kind': imageProviderKind},
        'caption': {'name': 'mock_caption', 'kind': captionProviderKind},
      },
      'blockers': blockers,
      'images': images.isEmpty
          ? List<Map<String, dynamic>>.generate(imageCount, (i) => {
                'position': i + 1,
                'view': i == 0 ? 'main_closeup_pov' : 'secondary_lifestyle',
                'publicUrl': 'https://storage.mock.local/slots/2026-10-12%2301/image-${i + 1}.png',
                'width': 1080,
                'height': 1920,
                'sizeBytes': 1024,
                'checksumSha256': 'a'.padRight(64, '${i + 1}').substring(0, 64),
                'provider': 'mock_image',
                'providerKind': imageProviderKind,
                'model': 'mock-v1',
                'promptVersion': 'part3-v1',
                'referenceImageUrl': 'https://cf.shopee.co.id/img/1.jpg',
              })
          : images,
      'product': {
        'name': 'Serum Vitamin C (produk katalog)',
        'affiliateUrl': 'https://s.shopee.co.id/aff-1',
        'source': 'catalog',
        'sourceProductId': '1',
        'categoryId': 'health-beauty',
        'referenceImageUrl': 'https://cf.shopee.co.id/img/1.jpg',
        'referenceAvailable': referenceAvailable,
        'referenceUnavailableReason': referenceUnavailableReason,
        'price': 120000,
        'currency': 'IDR',
        'commissionRate': 10,
        'rating': 4.8,
        'soldCount': 900,
        'category': 'Health & Beauty',
      },
      'caption': {
        'source': 'generated',
        'fullText':
            'Lagi cari serum vitamin C?\n\nKlik link di bawah untuk cek detailnya.\n\n'
                '#shopeeaffiliate #serum\nhttps://s.shopee.co.id/aff-1\n#ai #automation',
        'hashtags': ['#shopeeaffiliate', '#serum'],
        'mandatoryFinalHashtags': '#ai #automation',
        'mandatoryEndingPresent': mandatoryEndingPresent,
        'validationPassed': true,
        'blocking': <Map<String, dynamic>>[],
        'platforms': {
          'facebook_page': {'passed': true, 'fullText': 'sama'},
          'threads': {'passed': true, 'fullText': 'sama'},
        },
      },
      if (includeEditorial)
        'editorial': {
          'source': 'editorial_policy',
          'passed': editorialPassed,
          'mandatoryFinalHashtags': '#ai #automation',
          'mandatoryEndingPresent': mandatoryEndingPresent,
          'disclosurePresent': disclosurePresent,
          'blocking': editorialBlocking,
          'warnings': <Map<String, dynamic>>[],
          'limitations':
              'Heuristic structured claim detection + structural rules. Not a '
                  'substitute for human editorial review.',
        },
      if (includeImageQuality)
        'imageQuality': {
          'source': 'structural_image_quality',
          'passed': publishReady,
          'automatedFidelityScore': null,
          'limitations':
              'Structural checks only (format, size, dimensions, composition, '
                  'duplicate bytes). Product identity, packaging fidelity and '
                  'anatomy realism are NOT automatically verified.',
          'notAssessed': [
            {
              'dimension': 'product_identity',
              'reason': 'No vision-based fidelity scorer is configured.',
            },
            {
              'dimension': 'packaging_fidelity',
              'reason': 'No vision-based fidelity scorer is configured.',
            },
          ],
          'blocking': <Map<String, dynamic>>[],
        },
      'validation': {
        'source': 'real_validator_on_generated_content',
        'passed': publishReady,
        // The backend maps pipeline blockers into validation.blocking with
        // rule = blocker.code (mirrors buildPipelinePreview).
        'blocking': [
          for (final blocker in blockers)
            {'rule': blocker['code'], 'message': blocker['message']}
        ],
        'warnings': <Map<String, dynamic>>[],
        'platformsChecked': ['facebook_page', 'threads'],
      },
      'platforms': {
        'facebook': {
          'enabled': true,
          'status': 'not_attempted',
          'url': null,
          'detail':
              '$imageCount image(s) + caption validated and ready. Publication is not enabled yet.',
        },
        'threads': {
          'enabled': true,
          'status': 'not_attempted',
          'url': null,
          'detail':
              '$imageCount image(s) + caption validated and ready. Publication is not enabled yet.',
        },
      },
    };

/* -------------------------------------------------------------------------- */
/*  Part 6 fixtures: provider workspace, test results, usage summary          */
/* -------------------------------------------------------------------------- */

Map<String, dynamic> providerViewFixture({
  String id = 'prov-text-1',
  String name = 'acme-text',
  String displayName = 'Acme Text',
  String adapterType = 'openai_chat_completions',
  String adapterLabel = 'OpenAI-compatible chat',
  String baseUrl = 'https://api.acme.example/v1',
  String model = 'acme-large',
  String authType = 'bearer',
  bool enabled = true,
  Map<String, bool> capabilities = const {'text_generation': true},
  Map<String, Map<String, dynamic>> readiness = const {
    'configuration': {
      'status': 'ready',
      'testedAt': '2026-10-12T01:00:00.000Z',
      'detail': 'Configuration validated.',
      'requestId': null,
    },
    'text_generation': {
      'status': 'ready',
      'testedAt': '2026-10-12T01:05:00.000Z',
      'detail': 'Fixture test succeeded.',
      'requestId': 'req_1',
    },
  },
  bool secretPresent = false,
  String? secretMasked,
  bool secretKeyConfigured = true,
  List<String> selectedFor = const [],
}) =>
    {
      'id': id,
      'name': name,
      'displayName': displayName,
      'adapterType': adapterType,
      'adapterLabel': adapterLabel,
      'baseUrl': baseUrl,
      'model': model,
      'auth': {'type': authType},
      'enabled': enabled,
      'capabilities': capabilities,
      'readiness': readiness,
      'secret': {
        'present': secretPresent,
        'masked': secretMasked,
        'keyConfigured': secretKeyConfigured,
      },
      'selectedFor': selectedFor,
      'updatedAt': '2026-10-12T01:00:00.000Z',
    };

Map<String, dynamic> providersWorkspaceFixture({
  List<Map<String, dynamic>> providers = const [],
  String? textProviderId,
  String? imageProviderId,
  String? textProviderName,
  String? imageProviderName,
}) =>
    {
      'providers': providers,
      'selection': {
        'textProviderId': textProviderId,
        'imageProviderId': imageProviderId,
        'textProviderName': textProviderName,
        'imageProviderName': imageProviderName,
        'fallback': 'none',
        'note':
            'When the selected provider fails, the pipeline reports the error '
                'and blocks the slot. It never switches provider.',
      },
      'storage': 'memory',
      'secretsStorage': 'memory_aes256gcm',
      'capabilities': [
        'text_generation',
        'image_generation',
        'image_reference_input',
        'image_editing',
        'structured_output',
      ],
      'statuses': [
        'not_configured',
        'configuration_invalid',
        'authentication_failed',
        'ready',
        'capability_unsupported',
        'temporarily_unavailable',
        'rate_limited',
        'test_failed',
      ],
      'note': 'Credentials are write-only: the backend never returns a secret.',
    };

Map<String, dynamic> usageSummaryFixture({
  int dayRequests = 3,
  int dayFailures = 1,
  double dayKnownCostUsd = 0.006,
  int dayUnknownCostRequests = 1,
  double? dailyBudgetUsd,
  double? monthlyBudgetUsd,
  bool budgetBlocked = false,
  String? blockedScope,
}) =>
    {
      'timezone': 'Asia/Jakarta',
      'storage': 'memory',
      'day': {
        'requests': dayRequests,
        'failures': dayFailures,
        'inputTokens': 300,
        'outputTokens': 150,
        'images': 2,
        'knownCostUsd': dayKnownCostUsd,
        'actualCostUsd': dayKnownCostUsd,
        'estimatedCostUsd': 0,
        'unknownCostRequests': dayUnknownCostRequests,
      },
      'month': {
        'requests': dayRequests,
        'failures': dayFailures,
        'inputTokens': 300,
        'outputTokens': 150,
        'images': 2,
        'knownCostUsd': dayKnownCostUsd,
        'actualCostUsd': dayKnownCostUsd,
        'estimatedCostUsd': 0,
        'unknownCostRequests': dayUnknownCostRequests,
      },
      'budget': {
        'timezone': 'Asia/Jakarta',
        'dailyBudgetUsd': dailyBudgetUsd,
        'monthlyBudgetUsd': monthlyBudgetUsd,
        'day': {
          'from': '2026-10-12T00:00:00.000Z',
          'to': '2026-10-13T00:00:00.000Z',
          'spentUsd': dayKnownCostUsd,
          'budgetUsd': dailyBudgetUsd,
          'exhausted': budgetBlocked,
        },
        'month': {
          'from': '2026-10-01T00:00:00.000Z',
          'to': '2026-11-01T00:00:00.000Z',
          'spentUsd': dayKnownCostUsd,
          'budgetUsd': monthlyBudgetUsd,
          'exhausted': budgetBlocked,
        },
        'blocked': budgetBlocked,
        'blockedScope': blockedScope,
        'unknownCostRequests': dayUnknownCostRequests,
        'note':
            'Only provider-reported costs count toward the budget; unknown '
                'costs are surfaced separately.',
      },
      'recent': [
        {
          'id': 'usage-1',
          'at': '2026-10-12T03:00:00.000Z',
          'providerId': 'prov-text-1',
          'providerName': 'Acme Text',
          'adapterType': 'openai_chat_completions',
          'model': 'acme-large',
          'operation': 'text_generation',
          'requestId': 'req_1',
          'status': 'success',
          'latencyMs': 120,
          'inputTokens': 100,
          'outputTokens': 50,
          'images': null,
          'costUsd': 0.002,
          'costKind': 'actual',
          'errorCode': null,
        },
        {
          'id': 'usage-2',
          'at': '2026-10-12T03:05:00.000Z',
          'providerId': null,
          'providerName': 'env_default_image',
          'adapterType': 'openai_images',
          'model': 'mock-image-v1',
          'operation': 'image_generation',
          'requestId': 'req_2',
          'status': 'error',
          'latencyMs': 42,
          'inputTokens': null,
          'outputTokens': null,
          'images': null,
          'costUsd': null,
          'costKind': 'unknown',
          'errorCode': 'AI_PROVIDER_FAILED',
        },
      ],
      'note':
          'Per-request ledger. Costs are classified as actual, estimated or '
              'unknown — never silently treated as zero.',
    };

/* -------------------------------------------------------------------------- */
/*  Part 8 fixture: ops health report (GET /v1/ops/health)                     */
/* -------------------------------------------------------------------------- */

Map<String, dynamic> opsComponentFixture(
  String key,
  String displayName,
  String status, {
  String code = 'ok',
  String message = 'ok',
  String criticality = 'operational',
  Map<String, dynamic> data = const {},
}) =>
    {
      'key': key,
      'displayName': displayName,
      'status': status,
      'code': code,
      'message': message,
      'criticality': criticality,
      'data': data,
      'checkedAt': '2026-10-12T03:00:00.000Z',
    };

Map<String, dynamic> opsHealthFixture({
  String overall = 'healthy',
  bool ready = true,
  List<String> blockers = const [],
  String schedulerMode = 'mock',
  String automationState = 'running',
  bool schedulerEnabled = true,
  Map<String, dynamic>? queue,
  List<Map<String, dynamic>> recentEvents = const [],
  List<Map<String, dynamic>> components = const [],
}) =>
    {
      'overall': overall,
      'ready': ready,
      'blockers': blockers,
      'checkedAt': '2026-10-12T03:00:00.000Z',
      'components': components.isEmpty
          ? [
              opsComponentFixture('backend', 'Backend process', 'healthy',
                  code: 'ok', criticality: 'required'),
              opsComponentFixture('database', 'PostgreSQL', 'not_configured',
                  code: 'database_not_configured',
                  message: 'No database configured (development mode).',
                  criticality: 'required'),
              opsComponentFixture('migrations', 'Schema migrations', 'not_configured',
                  code: 'migrations_not_configured',
                  message: 'No database configured (development mode).',
                  criticality: 'required'),
              opsComponentFixture('scheduler', 'Scheduler', 'healthy',
                  code: 'ok'),
              opsComponentFixture('queue', 'Job queue', 'healthy', code: 'ok'),
              opsComponentFixture('caption_provider', 'Caption provider',
                  'not_configured',
                  code: 'provider_not_configured',
                  message: 'No text provider is selected.'),
              opsComponentFixture('image_provider', 'Image provider',
                  'not_configured',
                  code: 'provider_not_configured',
                  message: 'No image provider is selected.'),
              opsComponentFixture('asset_storage', 'Asset storage', 'healthy',
                  code: 'storage_ready', data: {'kind': 's3'}),
              opsComponentFixture('telegram', 'Telegram notifications',
                  'not_configured',
                  code: 'telegram_not_configured',
                  message: 'No bot token stored.',
                  criticality: 'optional'),
              opsComponentFixture('budget', 'Generation budget', 'healthy',
                  code: 'budget_not_configured'),
              opsComponentFixture('publishing_gate', 'Publishing gate',
                  'disabled',
                  code: 'publishing_disabled',
                  message: 'Live publishing is disabled by design.',
                  criticality: 'optional',
                  data: {
                    'facebook': 'disabled',
                    'threads': 'disabled',
                    'pipelineTerminalStage': 'publish_ready',
                  }),
            ]
          : components,
      'uptimeSeconds': 3600,
      'persistenceBackend': 'memory',
      'scheduler': {
        'enabled': schedulerEnabled,
        'mode': schedulerMode,
        'timezone': 'Asia/Jakarta',
        'automationState': automationState,
        'dailyPostTarget': 4,
        'slotsToday': 1,
        'today': '2026-10-12',
        'nextSlotAt': '2026-10-12T05:00:00.000Z',
        'lastTickAt': '2026-10-12T02:00:00.000Z',
        'lastSuccessfulTickAt': '2026-10-12T02:00:00.000Z',
        'lastTickSkipped': 0,
        'lastTickExecuted': 1,
      },
      'queue': queue ??
          {
            'pending': 2,
            'running': 0,
            'succeeded': 5,
            'failed': 1,
            'cancelled': 0,
            'retrying': 1,
            'oldestPendingAt': '2026-10-12T02:30:00.000Z',
            'oldestPendingAgeMs': 1800000,
            'expiredLeases': 0,
          },
      'recentEvents': recentEvents,
    };

Map<String, dynamic> opsEventFixture({
  String fingerprint = 'scheduler_tick_failed',
  String kind = 'scheduler_tick_failed',
  String severity = 'critical',
  String title = 'Scheduler tick failed',
  String? detail = 'boom',
  int occurrences = 3,
  String lastDeliveryStatus = 'sent',
  String? lastErrorCode,
  String? lastMessageId = '42',
  String? lastNotifiedAt = '2026-10-12T02:01:00.000Z',
}) =>
    {
      'fingerprint': fingerprint,
      'kind': kind,
      'severity': severity,
      'title': title,
      'detail': detail,
      'occurrences': occurrences,
      'firstSeenAt': '2026-10-12T02:00:00.000Z',
      'lastSeenAt': '2026-10-12T02:05:00.000Z',
      'cooldownUntil': '2026-10-12T02:16:00.000Z',
      'lastDeliveryStatus': lastDeliveryStatus,
      'lastErrorCode': lastErrorCode,
      'lastMessageId': lastMessageId,
      'lastNotifiedAt': lastNotifiedAt,
    };

Map<String, dynamic> providerTestResultFixture({
  bool ok = true,
  String kind = 'connection',
  String providerId = 'prov-text-1',
  String status = 'ready',
  String detail = 'Endpoint responded within the bounded timeout.',
  Map<String, Map<String, dynamic>> readiness = const {
    'configuration': {
      'status': 'ready',
      'testedAt': '2026-10-12T01:00:00.000Z',
      'detail': 'Configuration validated.',
      'requestId': 'req_1',
    },
  },
  Map<String, dynamic>? text,
  Map<String, dynamic>? image,
}) =>
    {
      'ok': ok,
      'kind': kind,
      'providerId': providerId,
      'status': status,
      'detail': detail,
      'durationMs': 84,
      'requestId': 'req_1',
      'readiness': readiness,
      'text': ?text,
      'image': ?image,
      'note': 'Bounded test with fixture data. Nothing was uploaded, stored '
          'or published to Facebook/Threads.',
    };
