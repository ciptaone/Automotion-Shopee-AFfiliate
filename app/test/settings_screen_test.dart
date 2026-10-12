import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shopee_affiliate_autopilot/models/image_count_policy.dart';
import 'package:shopee_affiliate_autopilot/screens/settings_screen.dart';

import 'helpers.dart';

/// Settings screen: locked defaults, validation, persistence through the
/// supported endpoint, and confirmed start/pause/resume controls.
void main() {
  setUp(seedSession);

  Future<void> pumpSettings(
    WidgetTester tester,
    MockClient client, {
    VoidCallback? onSignedOut,
  }) async {
    await pumpSurface(
      tester,
      SettingsScreen(api: apiFrom(client), onSignedOut: onSignedOut),
    );
    await settle(tester);
  }

  testWidgets('renders the locked defaults from the backend', (tester) async {
    final client = MockClient(
      (request) async => request.method == 'GET'
          ? jsonResponse(settingsFixture())
          : errorResponse(500, 'INTERNAL', 'unexpected'),
    );

    await pumpSettings(tester, client);

    expect(find.text('60'), findsOneWidget);
    expect(find.text('24'), findsWidgets);
    expect(find.text(ImageCountPolicy.randomOneOrTwo.label), findsOneWidget);
    expect(find.text('Running'), findsNothing);
    expect(find.text('Paused'), findsOneWidget);
    // Backend continues running when the APK is closed (persistent banner).
    expect(find.textContaining('keeps running on its own'), findsOneWidget);
  });

  testWidgets('persists edits through PUT /v1/settings', (tester) async {
    http.Request? putRequest;
    final client = MockClient((request) async {
      if (request.method == 'PUT') {
        putRequest = request;
        return jsonResponse(settingsFixture(intervalMinutes: 45, maxSlotsPerDay: 12));
      }
      return jsonResponse(settingsFixture());
    });

    await pumpSettings(tester, client);

    await tester.enterText(find.byType(TextFormField).at(0), '45');
    await tester.enterText(find.byType(TextFormField).at(1), '12');
    await settle(tester, frames: 2);

    await tester.ensureVisible(find.text('Save settings'));
    await tester.tap(find.text('Save settings'));
    await settle(tester);

    expect(putRequest, isNotNull);
    final body = jsonDecode(putRequest!.body) as Map<String, dynamic>;
    expect(body['intervalMinutes'], 45);
    expect(body['maxSlotsPerDay'], 12);
    expect(body['imageCountPolicy'], 'random_1_or_2');
    // The run state is never sent through the settings endpoint.
    expect(body.containsKey('automationState'), isFalse);

    expect(find.text('Settings saved on the backend.'), findsOneWidget);
  });

  testWidgets('rejects an interval below the minimum before sending', (tester) async {
    var putCalls = 0;
    final client = MockClient((request) async {
      if (request.method == 'PUT') putCalls += 1;
      return jsonResponse(settingsFixture());
    });

    await pumpSettings(tester, client);

    await tester.enterText(find.byType(TextFormField).at(0), '5');
    await settle(tester, frames: 2);

    await tester.ensureVisible(find.text('Save settings'));
    await tester.tap(find.text('Save settings'));
    await settle(tester);

    expect(find.text('Between 15 and 720'), findsOneWidget);
    expect(putCalls, 0);
  });

  testWidgets('flags a schedule that cannot fit one day', (tester) async {
    var putCalls = 0;
    final client = MockClient((request) async {
      if (request.method == 'PUT') putCalls += 1;
      return jsonResponse(settingsFixture());
    });

    await pumpSettings(tester, client);

    await tester.enterText(find.byType(TextFormField).at(0), '720');
    await tester.enterText(find.byType(TextFormField).at(1), '24');
    await settle(tester, frames: 2);

    expect(find.textContaining('exceed one 24-hour day'), findsOneWidget);

    await tester.ensureVisible(find.text('Save settings'));
    await tester.tap(find.text('Save settings'));
    await settle(tester);
    expect(putCalls, 0, reason: 'an impossible schedule is never sent');
  });

  testWidgets('renders backend validation issues on a rejected update', (tester) async {
    final client = MockClient((request) async {
      if (request.method == 'PUT') {
        return errorResponse(
          400,
          'INVALID_SETTINGS',
          'Settings rejected: too many slots.',
          issues: [
            {'rule': 'settings.maxSlotsPerDay', 'message': 'Must be 24 or fewer.'}
          ],
        );
      }
      return jsonResponse(settingsFixture());
    });

    await pumpSettings(tester, client);

    await tester.enterText(find.byType(TextFormField).at(1), '30');
    await settle(tester, frames: 2);
    // 30 exceeds the client-side maximum too, so the field validator catches it.
    await tester.ensureVisible(find.text('Save settings'));
    await tester.tap(find.text('Save settings'));
    await settle(tester);

    // Client-side guard fires first (30 > 24) — no request is wasted.
    expect(find.text('Between 1 and 24'), findsOneWidget);
  });

  testWidgets('surfaces backend issues when the client cannot catch them', (tester) async {
    final client = MockClient((request) async {
      if (request.method == 'PUT') {
        return errorResponse(
          400,
          'INVALID_SETTINGS',
          'Settings rejected.',
          issues: [
            {'rule': 'settings.intervalMinutes', 'message': 'Backend refused this interval.'}
          ],
        );
      }
      return jsonResponse(settingsFixture());
    });

    await pumpSettings(tester, client);

    // Valid client-side (120 min x 10 slots = 1200 min <= one day), so the
    // request really reaches the backend and its issues must surface.
    await tester.enterText(find.byType(TextFormField).at(0), '120');
    await tester.enterText(find.byType(TextFormField).at(1), '10');
    await settle(tester, frames: 2);
    await tester.ensureVisible(find.text('Save settings'));
    await tester.tap(find.text('Save settings'));
    await settle(tester);

    expect(find.textContaining('Backend refused this interval'), findsOneWidget);
  });

  testWidgets('pauses automation only after confirmation', (tester) async {
    final actions = <String>[];
    final client = MockClient((request) async {
      if (request.method == 'POST') {
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        actions.add('${body['action']}');
        return jsonResponse({
          'action': body['action'],
          'changed': true,
          'state': body['action'] == 'pause' ? 'paused' : 'running',
          'settings': settingsFixture(state: body['action'] == 'pause' ? 'paused' : 'running')
              ['settings'],
          'note': 'Backend state updated.',
        });
      }
      return jsonResponse(settingsFixture(state: 'running'));
    });

    await pumpSettings(tester, client);
    expect(find.text('Running'), findsOneWidget);

    await tester.tap(find.text('Pause'));
    await settle(tester);

    // Confirmation dialog appears first.
    expect(find.text('Pause automation?'), findsOneWidget);
    expect(actions, isEmpty);

    await tester.tap(find.text('Cancel'));
    await settle(tester);
    expect(actions, isEmpty, reason: 'cancelling must not call the backend');

    await tester.tap(find.text('Pause'));
    await settle(tester);
    await tester.tap(find.text('Pause').last);
    await settle(tester);

    expect(actions, ['pause']);
    expect(find.text('Paused'), findsOneWidget);
  });

  testWidgets('starts automation after confirmation', (tester) async {
    final actions = <String>[];
    final client = MockClient((request) async {
      if (request.method == 'POST') {
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        actions.add('${body['action']}');
        return jsonResponse({
          'action': 'start',
          'changed': true,
          'state': 'running',
          'settings': settingsFixture(state: 'running')['settings'],
          'note': 'The backend keeps running independently of the APK lifecycle.',
        });
      }
      return jsonResponse(settingsFixture());
    });

    await pumpSettings(tester, client);

    await tester.tap(find.text('Start'));
    await settle(tester);
    await tester.tap(find.text('Start').last);
    await settle(tester);

    expect(actions, ['start']);
    expect(find.text('Running'), findsOneWidget);
  });

  testWidgets('shows a retry state when settings cannot be loaded', (tester) async {
    final client = MockClient((request) async => throw const SocketException('down'));

    await pumpSettings(tester, client, onSignedOut: () {});

    expect(find.textContaining('Cannot reach the backend'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
  });

  testWidgets('signs out when the session is rejected', (tester) async {
    var signedOut = false;
    final client = MockClient(
      (request) async => errorResponse(401, 'UNAUTHENTICATED', 'expired'),
    );

    await pumpSettings(tester, client, onSignedOut: () => signedOut = true);
    expect(signedOut, isTrue);
  });

  testWidgets('never renders credential-looking strings', (tester) async {
    final client = MockClient((request) async => jsonResponse(settingsFixture()));
    await pumpSettings(tester, client);

    final rendered =
        tester.widgetList<Text>(find.byType(Text)).map((t) => t.data ?? '').join('\n');
    expect(rendered, isNot(contains(kTestToken)));
    expect(rendered.toLowerCase(), isNot(contains('access_token')));
  });
}

