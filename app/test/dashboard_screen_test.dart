import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:shopee_affiliate_autopilot/screens/dashboard_screen.dart';

import 'helpers.dart';

/// Dashboard rendering: status, slot capacity, publication counters, honest
/// empty state for generated content, offline handling and sign-out.
void main() {
  setUp(seedSession);

  testWidgets('renders a running dashboard from a backend payload', (tester) async {
    final client = MockClient((request) async {
      expect(request.url.path, '/v1/automation/status');
      return jsonResponse(automationStatusFixture(state: 'running', slotsUsed: 6));
    });

    await pumpSurface(tester, DashboardScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Running'), findsOneWidget);
    expect(find.text('Automation status'), findsOneWidget);
    expect(find.text('18 left'), findsOneWidget);
    expect(find.text('24 slots scheduled'), findsOneWidget);
    expect(find.text('6 slots'), findsOneWidget);
    expect(find.text('Succeeded'), findsOneWidget);
    expect(find.text('Failed'), findsOneWidget);
    expect(find.text('Retrying'), findsOneWidget);
    expect(find.textContaining('2026-10-12#01'), findsOneWidget);
  });

  testWidgets('shows the locked schedule defaults', (tester) async {
    final client = MockClient((request) async => jsonResponse(automationStatusFixture()));

    await pumpSurface(tester, DashboardScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.textContaining('Asia/Jakarta'), findsWidgets);
    expect(find.text('24 slots scheduled'), findsOneWidget);
  });

  testWidgets('marks the automation as paused', (tester) async {
    final client = MockClient((request) async => jsonResponse(automationStatusFixture(state: 'paused')));

    await pumpSurface(tester, DashboardScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Paused'), findsOneWidget);
    expect(
      find.textContaining('Automation is paused'),
      findsOneWidget,
    );
  });

  testWidgets('surfaces a degraded state with its reasons', (tester) async {
    final client = MockClient(
      (request) async => jsonResponse(automationStatusFixture(
        state: 'running',
        degraded: true,
        degradedReasons: const ['No publishing destination is live-configured.'],
      )),
    );

    await pumpSurface(tester, DashboardScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Degraded'), findsOneWidget);
    expect(find.textContaining('No publishing destination'), findsOneWidget);
  });

  testWidgets('shows an honest empty state for generated content', (tester) async {
    final client = MockClient((request) async => jsonResponse(automationStatusFixture()));

    await pumpSurface(tester, DashboardScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Nothing generated yet'), findsOneWidget);
    expect(find.textContaining('not implemented'), findsOneWidget);
  });

  testWidgets('renders an empty activity list when the queue is empty', (tester) async {
    final client = MockClient(
      (request) async => jsonResponse(automationStatusFixture(activity: const [])),
    );

    await pumpSurface(tester, DashboardScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('No activity yet'), findsOneWidget);
  });

  testWidgets('shows a full-screen error when the backend is offline at startup',
      (tester) async {
    final client = MockClient((request) async => throw const SocketException('down'));

    await pumpSurface(tester, DashboardScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.textContaining('Cannot reach the backend'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
  });

  testWidgets('keeps last known data and marks Offline when the backend drops',
      (tester) async {
    var calls = 0;
    final client = MockClient((request) async {
      calls += 1;
      if (calls == 1) return jsonResponse(automationStatusFixture(state: 'running'));
      throw const SocketException('failed host lookup');
    });

    await pumpSurface(tester, DashboardScreen(api: apiFrom(client)));
    await settle(tester);
    expect(find.text('Running'), findsOneWidget);

    await tester.tap(find.byTooltip('Refresh'));
    await settle(tester);

    expect(find.text('Offline'), findsOneWidget);
    expect(
      find.text('Backend offline — showing the last known state.'),
      findsOneWidget,
    );
    // Last known data is still on screen.
    expect(find.text('24 slots scheduled'), findsOneWidget);
  });

  testWidgets('goes Offline when a refresh fails and recovers when it succeeds',
      (tester) async {
    var calls = 0;
    final client = MockClient((request) async {
      calls += 1;
      // A logical GET may make two attempts before reporting the backend offline.
      if (calls == 2 || calls == 3) throw const SocketException('failed host lookup');
      return jsonResponse(automationStatusFixture(state: 'running'));
    });

    await pumpSurface(tester, DashboardScreen(api: apiFrom(client)));
    await settle(tester);
    expect(find.text('Running'), findsOneWidget);

    await tester.tap(find.byTooltip('Refresh'));
    await settle(tester);
    expect(find.text('Offline'), findsOneWidget);

    await tester.tap(find.byTooltip('Refresh'));
    await settle(tester);
    expect(find.text('Running'), findsOneWidget);
    expect(calls, 4); // 1 initial + 2 failed attempts + 1 recovery
  });

  testWidgets('signs the operator out when the session is rejected', (tester) async {
    var signedOut = false;
    final client = MockClient(
      (request) async => errorResponse(401, 'UNAUTHENTICATED', 'Session expired'),
    );

    await pumpSurface(tester, DashboardScreen(api: apiFrom(client), onSignOut: () => signedOut = true));
    await settle(tester);

    expect(signedOut, isTrue);
  });

  testWidgets('never renders credential-looking strings', (tester) async {
    final client = MockClient((request) async => jsonResponse(automationStatusFixture()));

    await pumpSurface(tester, DashboardScreen(api: apiFrom(client)));
    await settle(tester);

    final rendered = tester.widgetList<Text>(find.byType(Text)).map((t) => t.data ?? '').join('\n');
    expect(rendered, isNot(contains(kTestToken)));
    expect(rendered.toLowerCase(), isNot(contains('install-key')));
    expect(rendered.toLowerCase(), isNot(contains('bearer ')));
  });
}

