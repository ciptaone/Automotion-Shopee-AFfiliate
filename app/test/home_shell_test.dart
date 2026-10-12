import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:shopee_affiliate_autopilot/screens/home_shell.dart';

import 'helpers.dart';

/// The post-login shell: five tabs, each backed by a real endpoint fixture.
void main() {
  setUp(seedSession);

  MockClient router() => MockClient((request) async {
        switch (request.url.path) {
          case '/health':
            return jsonResponse({'status': 'ok', 'version': '0.1.0'});
          case '/v1/automation/status':
            return jsonResponse(automationStatusFixture(state: 'running'));
          case '/v1/settings':
            return jsonResponse(settingsFixture());
          case '/v1/content/preview':
            return jsonResponse(previewFixture(imageCount: 2));
          case '/v1/history/publishes':
            return jsonResponse(historyFixture());
          case '/v1/meta/integrations':
            return jsonResponse(integrationsFixture());
          default:
            return errorResponse(404, 'NOT_FOUND', 'Route not found');
        }
      });

  testWidgets('shows the dashboard first and switches tabs', (tester) async {
    await pumpSurface(tester, HomeShell(api: apiFrom(router())));
    await settle(tester);

    expect(find.text('Dashboard'), findsWidgets);
    expect(find.text('Running'), findsOneWidget);

    await tester.tap(find.text('Preview'));
    await settle(tester);

    expect(find.text('Content preview'), findsOneWidget);
    expect(find.text('Image 1 of 2'), findsOneWidget);
    expect(find.text('Image 2 of 2'), findsOneWidget);

    await tester.tap(find.text('Services'));
    await settle(tester);

    expect(find.text('Integrations'), findsOneWidget);
    expect(find.text('Online'), findsOneWidget);

    await tester.tap(find.text('History'));
    await settle(tester);

    expect(find.text('Publishing history'), findsOneWidget);
    expect(find.text('Error summary'), findsNWidgets(2));
  });

  testWidgets('keeps dashboard state when returning to the first tab', (tester) async {
    var statusCalls = 0;
    final client = MockClient((request) async {
      switch (request.url.path) {
        case '/health':
          return jsonResponse({'status': 'ok'});
        case '/v1/automation/status':
          statusCalls += 1;
          return jsonResponse(automationStatusFixture(state: 'running'));
        case '/v1/settings':
          return jsonResponse(settingsFixture());
        case '/v1/content/preview':
          return jsonResponse(previewFixture());
        case '/v1/history/publishes':
          return jsonResponse(historyFixture());
        case '/v1/meta/integrations':
          return jsonResponse(integrationsFixture());
        default:
          return errorResponse(404, 'NOT_FOUND', 'Route not found');
      }
    });

    await pumpSurface(tester, HomeShell(api: apiFrom(client)));
    await settle(tester);
    expect(statusCalls, 1);

    await tester.tap(find.text('Settings'));
    await settle(tester);
    await tester.tap(find.text('Dashboard'));
    await settle(tester);

    expect(statusCalls, 1, reason: 'tabs stay alive in an IndexedStack');
    expect(find.text('Running'), findsOneWidget);
  });
}
