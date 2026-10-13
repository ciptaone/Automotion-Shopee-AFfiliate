import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:shopee_affiliate_autopilot/screens/providers_screen.dart';

import 'helpers.dart';

/// PART 6 §2/§3/§6/§10 — the provider workspace surface.
///
/// Every test runs against a MockClient: no socket is opened, no credential
/// ever exists, and nothing is published.
void main() {
  setUp(seedSession);

  MockClient router({
    List<Map<String, dynamic>> providers = const [],
    String? textProviderId,
    String? imageProviderId,
    Map<String, dynamic>? testResult,
    Map<String, dynamic>? selectionResponse,
    List<String> calls = const [],
  }) =>
      MockClient((request) async {
        calls = [...calls, '${request.method} ${request.url.path}'];
        switch (request.method) {
          case 'GET':
            if (request.url.path == '/v1/providers') {
              return jsonResponse(providersWorkspaceFixture(
                providers: providers,
                textProviderId: textProviderId,
                imageProviderId: imageProviderId,
              ));
            }
            if (request.url.path == '/v1/usage/summary') {
              return jsonResponse(usageSummaryFixture());
            }
            return errorResponse(404, 'NOT_FOUND', 'Route not found');
          case 'POST':
            if (request.url.path.endsWith('/test/connection') ||
                request.url.path.endsWith('/test/text') ||
                request.url.path.endsWith('/test/image')) {
              return jsonResponse(testResult ?? providerTestResultFixture());
            }
            return errorResponse(404, 'NOT_FOUND', 'Route not found');
          case 'PUT':
            if (request.url.path == '/v1/providers/selection') {
              return jsonResponse(selectionResponse ?? {
                'textProviderId': null,
                'imageProviderId': null,
                'textProviderName': null,
                'imageProviderName': null,
                'fallback': 'none',
                'note': 'When the selected provider fails, the pipeline '
                    'reports the error and blocks the slot.',
              });
            }
            return errorResponse(404, 'NOT_FOUND', 'Route not found');
          default:
            return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Not allowed');
        }
      });

  Future<void> pumpScreen(WidgetTester tester, MockClient client) async {
    await pumpSurface(tester, ProvidersScreen(api: apiFrom(client)));
    await settle(tester);
  }

  testWidgets('renders the empty state with a clear next step', (tester) async {
    await pumpScreen(tester, router());

    expect(find.text('No providers configured'), findsOneWidget);
    expect(
      find.textContaining('Add an OpenAI-compatible or Ollama endpoint'),
      findsOneWidget,
    );
    // The no-fallback policy is always visible (banner + selection note).
    expect(
      find.textContaining('never switches provider'),
      findsWidgets,
    );
  });

  testWidgets('lists a provider with capability and readiness indicators',
      (tester) async {
    await pumpScreen(tester, router(providers: [
      providerViewFixture(
        capabilities: const {
          'text_generation': true,
          'image_generation': false,
        },
      ),
    ]));

    expect(find.text('Acme Text'), findsOneWidget);
    expect(find.text('https://api.acme.example/v1'), findsOneWidget);
    expect(find.text('acme-large'), findsOneWidget);
    // Readiness rows: honest, per-capability states.
    expect(find.text('Configuration'), findsOneWidget);
    expect(find.text('Authentication'), findsOneWidget);
    expect(find.text('Text generation'), findsOneWidget);
    expect(find.text('Ready'), findsWidgets);
    // Test buttons appear only for declared capabilities.
    expect(find.text('Test connection'), findsOneWidget);
    expect(find.text('Test text'), findsOneWidget);
    expect(find.text('Test image'), findsNothing); // no image capability
  });

  testWidgets('a stored secret is shown masked and never in clear text',
      (tester) async {
    await pumpScreen(tester, router(providers: [
      providerViewFixture(
        secretPresent: true,
        secretMasked: 'sk-l••••••••7890',
      ),
    ]));

    expect(find.textContaining('sk-l'), findsOneWidget);
    expect(find.textContaining('value never displayed'), findsOneWidget);
    expect(find.text('Replace key'), findsOneWidget);
  });

  testWidgets('a missing server key surfaces as an explicit error state',
      (tester) async {
    await pumpScreen(tester, router(providers: [
      providerViewFixture(secretKeyConfigured: false),
    ]));

    expect(
      find.textContaining('SECRETS_ENCRYPTION_KEY'),
      findsOneWidget,
    );
    expect(find.text('Store key'), findsNothing);
  });

  testWidgets('a connection test reports a sanitized result and never publishes',
      (tester) async {
    await pumpScreen(tester, router(
      providers: [providerViewFixture()],
      testResult: providerTestResultFixture(
        readiness: const {
          'configuration': {
            'status': 'ready',
            'testedAt': '2026-10-12T01:00:00.000Z',
            'detail': 'Configuration validated.',
            'requestId': 'req_1',
          },
          'authentication': {
            'status': 'ready',
            'testedAt': '2026-10-12T01:00:00.000Z',
            'detail': 'Credential accepted.',
            'requestId': 'req_1',
          },
        },
      ),
    ));

    await tester.tap(find.text('Test connection'));
    await settle(tester);

    expect(find.text('connection test — Ready'), findsOneWidget);
    expect(find.text('PASSED'), findsOneWidget);
    expect(
      find.textContaining('Nothing was uploaded, stored or published'),
      findsOneWidget,
    );

    await tester.tap(find.text('Close'));
    await settle(tester);
  });

  testWidgets('a failed test shows FAILED exactly once with the honest status',
      (tester) async {
    await pumpScreen(tester, router(
      providers: [providerViewFixture()],
      testResult: providerTestResultFixture(
        ok: false,
        status: 'authentication_failed',
        detail: 'The provider rejected the credential (HTTP 401).',
        readiness: const {
          'authentication': {
            'status': 'authentication_failed',
            'testedAt': '2026-10-12T01:00:00.000Z',
            'detail': 'The provider rejected the credential.',
            'requestId': 'req_1',
          },
        },
      ),
    ));

    await tester.tap(find.text('Test connection'));
    await settle(tester);

    expect(find.textContaining('FAILED'), findsOneWidget);
    expect(find.textContaining('Authentication failed'), findsOneWidget);
    expect(find.text('The provider rejected the credential (HTTP 401).'),
        findsOneWidget);
  });

  testWidgets('selecting providers is independent for text and image',
      (tester) async {
    final textProvider = providerViewFixture();
    final imageProvider = providerViewFixture(
      id: 'prov-image-1',
      name: 'acme-image',
      displayName: 'Acme Image',
      adapterType: 'openai_images',
      adapterLabel: 'OpenAI-compatible images',
      baseUrl: 'https://images.acme.example/v1',
      model: 'acme-diffusion',
      capabilities: const {'image_generation': true},
      readiness: const {
        'configuration': {
          'status': 'ready',
          'testedAt': '2026-10-12T01:00:00.000Z',
          'detail': 'Configuration validated.',
          'requestId': null,
        },
      },
    );

    await pumpScreen(tester, router(
      providers: [textProvider, imageProvider],
      textProviderId: 'prov-text-1',
      imageProviderId: 'prov-image-1',
    ));

    expect(find.text('Text (captions) provider'), findsOneWidget);
    expect(find.text('Image provider'), findsOneWidget);
    expect(find.text('Acme Text'), findsWidgets);
    expect(find.text('Acme Image'), findsWidgets);
    expect(
      find.textContaining('Fallback policy: none'),
      findsOneWidget,
    );
  });

  testWidgets('shows the usage ledger with honest cost classification',
      (tester) async {
    await pumpScreen(tester, router());

    expect(find.text('Usage & budget'), findsOneWidget);
    expect(find.textContaining('3 request(s)'), findsOneWidget);
    expect(find.textContaining('0.0060'), findsOneWidget);
    expect(find.textContaining('1 request(s) — cost not reported'), findsOneWidget);
    expect(find.textContaining('Not configured (unlimited)'), findsNWidgets(2));
  });

  testWidgets('surfaces a budget-blocked state when the budget is exhausted',
      (tester) async {
    final client = MockClient((request) async {
      if (request.url.path == '/v1/usage/summary') {
        return jsonResponse(usageSummaryFixture(
          dayRequests: 12,
          dailyBudgetUsd: 1.0,
          budgetBlocked: true,
          blockedScope: 'daily',
        ));
      }
      return jsonResponse(providersWorkspaceFixture());
    });

    await pumpScreen(tester, client);

    expect(
      find.textContaining('Generation blocked (daily)'),
      findsOneWidget,
    );
  });

  testWidgets('an API failure renders a clear error state with retry',
      (tester) async {
    final client = MockClient((request) async {
      if (request.url.path == '/v1/providers') {
        return errorResponse(500, 'INTERNAL', 'Database is unavailable');
      }
      return jsonResponse(usageSummaryFixture());
    });

    await pumpScreen(tester, client);

    // 5xx details are sanitized by the client: no internal message leaks.
    expect(find.textContaining('Backend error (HTTP 500)'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
  });
}
