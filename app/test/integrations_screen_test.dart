import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:shopee_affiliate_autopilot/screens/integrations_screen.dart';

import 'helpers.dart';

/// Integrations screen: backend connectivity, the four-state vocabulary and the
/// guarantee that no secret is ever rendered.
void main() {
  setUp(seedSession);

  testWidgets('reports backend connectivity and per-service health', (tester) async {
    final client = MockClient((request) async {
      if (request.url.path == '/health') {
        return jsonResponse({'status': 'ok'});
      }
      return jsonResponse(integrationsFixture());
    });

    await pumpSurface(tester, IntegrationsScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Online'), findsOneWidget);
    expect(find.text('http://backend.test'), findsOneWidget);
    expect(find.textContaining('ms'), findsWidgets);

    expect(find.text('Facebook Page'), findsOneWidget);
    expect(find.text('Threads'), findsOneWidget);
    expect(find.text('Telegram'), findsOneWidget);
    expect(find.text('Shopee product feed'), findsOneWidget);

    expect(find.text('Not tested'), findsNWidgets(2)); // Facebook Page + AI image
    expect(find.text('Disconnected'), findsNWidgets(2)); // Threads + Telegram
    expect(find.text('Blocked'), findsOneWidget); // Shopee feed
  });

  testWidgets('never claims Connected for a not-tested service', (tester) async {
    final client = MockClient((request) async {
      if (request.url.path == '/health') {
        return jsonResponse({'status': 'ok'});
      }
      return jsonResponse(integrationsFixture(
        facebookHealth: 'not_tested',
        threadsHealth: 'not_tested',
      ));
    });

    await pumpSurface(tester, IntegrationsScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Connected'), findsNothing);
    expect(find.text('Not tested'), findsNWidgets(3));
  });

  testWidgets('shows the state legend', (tester) async {
    final client = MockClient((request) async {
      if (request.url.path == '/health') {
        return jsonResponse({'status': 'ok'});
      }
      return jsonResponse(integrationsFixture());
    });

    await pumpSurface(tester, IntegrationsScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('What the states mean'), findsOneWidget);
    expect(find.text('No access tokens, keys or secrets are displayed anywhere in this app.'),
        findsOneWidget);
  });

  testWidgets('shows an error state when the backend is unreachable', (tester) async {
    final client = MockClient((request) async => throw const SocketException('down'));

    await pumpSurface(tester, IntegrationsScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Retry'), findsOneWidget);
    expect(find.textContaining('not reachable'), findsOneWidget);
  });

  testWidgets('shows an offline banner when a refresh fails but data is cached',
      (tester) async {
    var pings = 0;
    final client = MockClient((request) async {
      if (request.url.path == '/health') {
        pings += 1;
        // A logical probe may make two attempts before declaring the backend down.
        if (pings > 1) throw const SocketException('down');
        return jsonResponse({'status': 'ok'});
      }
      return jsonResponse(integrationsFixture());
    });

    await pumpSurface(tester, IntegrationsScreen(api: apiFrom(client)));
    await settle(tester);
    expect(find.text('Online'), findsOneWidget);

    await tester.tap(find.byTooltip('Refresh'));
    await settle(tester);

    expect(find.text('Offline'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
    // Cached entries stay on screen while the backend is unreachable.
    expect(find.text('Facebook Page'), findsOneWidget);
  });

  testWidgets('never renders credential-looking strings', (tester) async {
    final client = MockClient((request) async {
      if (request.url.path == '/health') {
        return jsonResponse({'status': 'ok'});
      }
      return jsonResponse(integrationsFixture());
    });

    await pumpSurface(tester, IntegrationsScreen(api: apiFrom(client)));
    await settle(tester);

    final rendered =
        tester.widgetList<Text>(find.byType(Text)).map((t) => t.data ?? '').join('\n');
    expect(rendered, isNot(contains(kTestToken)));
    expect(rendered.toLowerCase(), isNot(contains('access_token')));
    expect(rendered.toLowerCase(), isNot(contains('bearer ')));
  });
}
