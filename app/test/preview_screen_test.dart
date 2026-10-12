import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:shopee_affiliate_autopilot/screens/preview_screen.dart';

import 'helpers.dart';

/// Content preview: 1- vs 2-image slots, stability across refreshes, validation
/// status and per-platform publication state — all clearly marked as fixtures.
void main() {
  setUp(seedSession);

  testWidgets('renders a two-image fixture slot', (tester) async {
    final client = MockClient((request) async => jsonResponse(previewFixture(imageCount: 2)));

    await pumpSurface(tester, PreviewScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Image 1 of 2'), findsOneWidget);
    expect(find.text('Image 2 of 2'), findsOneWidget);
    expect(find.text('2 images'), findsOneWidget);
    expect(find.text('fixture placeholder'), findsNWidgets(2));
    expect(find.textContaining('Fixture content'), findsOneWidget);
  });

  testWidgets('renders a one-image fixture slot', (tester) async {
    final client = MockClient((request) async => jsonResponse(previewFixture(imageCount: 1)));

    await pumpSurface(tester, PreviewScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Image 1 of 1'), findsOneWidget);
    expect(find.text('1 image'), findsOneWidget);
    expect(find.text('Image 2 of 1'), findsNothing);
    expect(find.text('fixture placeholder'), findsOneWidget);
  });

  testWidgets('keeps the selected image count stable across refreshes', (tester) async {
    var calls = 0;
    final client = MockClient((request) async {
      calls += 1;
      // The backend returns the same count for the same slot on every call.
      return jsonResponse(previewFixture(imageCount: 2));
    });

    await pumpSurface(tester, PreviewScreen(api: apiFrom(client)));
    await settle(tester);
    expect(find.text('Image 2 of 2'), findsOneWidget);

    await tester.tap(find.byTooltip('Refresh'));
    await settle(tester);

    expect(calls, 2);
    expect(find.text('Image 1 of 2'), findsOneWidget);
    expect(find.text('Image 2 of 2'), findsOneWidget);
  });

  testWidgets('states that both platforms share one count', (tester) async {
    final client = MockClient((request) async => jsonResponse(previewFixture(imageCount: 2)));

    await pumpSurface(tester, PreviewScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.textContaining('shared by both platforms'), findsWidgets);
    expect(find.textContaining('same caption and the same 2'), findsOneWidget);
  });

  testWidgets('shows the validation verdict and warnings', (tester) async {
    final client = MockClient((request) async => jsonResponse(previewFixture()));

    await pumpSurface(tester, PreviewScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Passed'), findsOneWidget);
    expect(find.text('real_validator_on_fixture_text'), findsOneWidget);
    expect(find.textContaining('caption.hashtag_minimum'), findsOneWidget);
  });

  testWidgets('shows blocking issues when validation fails', (tester) async {
    final client = MockClient(
      (request) async => jsonResponse(previewFixture(validationPassed: false)),
    );

    await pumpSurface(tester, PreviewScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Blocked'), findsOneWidget);
    expect(find.textContaining('affiliate_link_embedded'), findsOneWidget);
  });

  testWidgets('renders both platforms as not attempted', (tester) async {
    final client = MockClient((request) async => jsonResponse(previewFixture()));

    await pumpSurface(tester, PreviewScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Facebook Page'), findsOneWidget);
    expect(find.text('Threads'), findsOneWidget);
    expect(find.text('Not attempted'), findsNWidgets(2));
  });

  testWidgets('marks a disabled platform as Disabled', (tester) async {
    final client = MockClient(
      (request) async => jsonResponse(previewFixture(threadsEnabled: false)),
    );

    await pumpSurface(tester, PreviewScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Disabled'), findsOneWidget);
    expect(find.text('Not attempted'), findsOneWidget);
  });

  testWidgets('shows the product name and affiliate URL', (tester) async {
    final client = MockClient((request) async => jsonResponse(previewFixture()));

    await pumpSurface(tester, PreviewScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Tumbler Stainless 500 ml (contoh fixture)'), findsOneWidget);
    expect(find.textContaining('shopee.co.id'), findsWidgets);
  });

  testWidgets('shows a retry state when the preview cannot load', (tester) async {
    final client = MockClient((request) async => throw const SocketException('down'));

    await pumpSurface(tester, PreviewScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Retry'), findsOneWidget);
    expect(find.textContaining('Cannot reach the backend'), findsOneWidget);
  });

  testWidgets('never renders credential-looking strings', (tester) async {
    final client = MockClient((request) async => jsonResponse(previewFixture()));

    await pumpSurface(tester, PreviewScreen(api: apiFrom(client)));
    await settle(tester);

    final rendered =
        tester.widgetList<Text>(find.byType(Text)).map((t) => t.data ?? '').join('\n');
    expect(rendered, isNot(contains(kTestToken)));
    expect(rendered.toLowerCase(), isNot(contains('bearer ')));
  });
}
