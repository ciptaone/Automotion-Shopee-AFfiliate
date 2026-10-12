import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:shopee_affiliate_autopilot/screens/history_screen.dart';

import 'helpers.dart';

/// Publishing history: independent Facebook/Threads results, links, error
/// summary, retry status, plus loading / empty / error states.
void main() {
  setUp(seedSession);

  testWidgets('renders fixture records with independent platform results',
      (tester) async {
    final client = MockClient((request) async => jsonResponse(historyFixture()));

    await pumpSurface(tester, HistoryScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.textContaining('Fixture history'), findsOneWidget);
    expect(find.text('Tumbler Stainless 500 ml (contoh fixture)'), findsNWidgets(3));

    // Independent statuses are all represented.
    expect(find.text('Published'), findsNWidgets(3));
    expect(find.text('Failed'), findsNWidgets(2));
    expect(find.text('Not attempted'), findsOneWidget);

    // Post links are shown when available.
    expect(find.textContaining('facebook.com/permalink.php'), findsNWidgets(2));
    expect(find.textContaining('threads.net'), findsOneWidget);
  });

  testWidgets('shows the error summary and retry state per record', (tester) async {
    final client = MockClient((request) async => jsonResponse(historyFixture()));

    await pumpSurface(tester, HistoryScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Error summary'), findsNWidgets(2));
    expect(find.text('Retry: pending (1/3)'), findsOneWidget);
    expect(find.text('Retry: exhausted (3/3)'), findsOneWidget);
    expect(find.text('Retry: none (0/3)'), findsOneWidget);
  });

  testWidgets('shows the image count for each record', (tester) async {
    final client = MockClient((request) async => jsonResponse(historyFixture()));

    await pumpSurface(tester, HistoryScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('2 img'), findsNWidgets(2));
    expect(find.text('1 img'), findsOneWidget);
  });

  testWidgets('shows an empty state when there is no history', (tester) async {
    final client = MockClient(
      (request) async => jsonResponse({
        'items': <dynamic>[],
        'count': 0,
        'source': 'fixture',
        'note': 'Fixture history — sample records only.',
      }),
    );

    await pumpSurface(tester, HistoryScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('No publications yet'), findsOneWidget);
  });

  testWidgets('shows a retry state when the backend is offline', (tester) async {
    final client = MockClient((request) async => throw const SocketException('down'));

    await pumpSurface(tester, HistoryScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Retry'), findsOneWidget);
    expect(find.textContaining('Cannot reach the backend'), findsOneWidget);
  });

  testWidgets('signs out when the session is rejected', (tester) async {
    var signedOut = false;
    final client = MockClient(
      (request) async => errorResponse(401, 'UNAUTHENTICATED', 'expired'),
    );

    await tester.pumpWidget(
      appSurface(HistoryScreen(api: apiFrom(client), onSignedOut: () => signedOut = true)),
    );
    await settle(tester);

    expect(signedOut, isTrue);
  });

  testWidgets('never renders credential-looking strings', (tester) async {
    final client = MockClient((request) async => jsonResponse(historyFixture()));

    await pumpSurface(tester, HistoryScreen(api: apiFrom(client)));
    await settle(tester);

    final rendered =
        tester.widgetList<Text>(find.byType(Text)).map((t) => t.data ?? '').join('\n');
    expect(rendered, isNot(contains(kTestToken)));
    expect(rendered.toLowerCase(), isNot(contains('access_token')));
  });
}
