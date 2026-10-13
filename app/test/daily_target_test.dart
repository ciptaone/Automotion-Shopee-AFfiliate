import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shopee_affiliate_autopilot/screens/settings_screen.dart';

import 'helpers.dart';

/// PART 6 §7/§10 — the daily posting plan card on the settings screen.
///
/// The daily target is 3 or 4 posts per Asia/Jakarta day, and the four WIB
/// windows are shown with the first N selected. Budgets are optional.
void main() {
  setUp(seedSession);

  Future<void> pumpSettings(WidgetTester tester, MockClient client) async {
    await pumpSurface(
      tester,
      SettingsScreen(api: apiFrom(client)),
    );
    await settle(tester);
  }

  testWidgets('shows the daily target default and the four WIB windows',
      (tester) async {
    final client = MockClient(
      (request) async => request.method == 'GET'
          ? jsonResponse(settingsFixture())
          : errorResponse(500, 'INTERNAL', 'unexpected'),
    );

    await pumpSettings(tester, client);

    expect(find.text('Daily posting plan'), findsOneWidget);
    // Default target = 4 posts.
    expect(find.text('4 posts'), findsOneWidget);
    expect(find.text('3 posts'), findsOneWidget);
    // All four WIB windows are listed.
    expect(find.text('06:00-07:00 WIB'), findsOneWidget);
    expect(find.text('12:00-13:00 WIB'), findsOneWidget);
    expect(find.text('16:00-17:00 WIB'), findsOneWidget);
    expect(find.text('19:00-20:00 WIB'), findsOneWidget);
  });

  testWidgets('switching the target to 3 marks the evening window as skipped',
      (tester) async {
    final client = MockClient(
      (request) async => request.method == 'GET'
          ? jsonResponse(settingsFixture())
          : errorResponse(500, 'INTERNAL', 'unexpected'),
    );

    await pumpSettings(tester, client);

    await tester.tap(find.text('3 posts'));
    await settle(tester);

    expect(
      find.textContaining('The first 3 windows'),
      findsOneWidget,
    );
    expect(
      find.textContaining('evening window is skipped'),
      findsOneWidget,
    );
  });

  testWidgets('the daily target is persisted through PUT /v1/settings',
      (tester) async {
    http.Request? putRequest;
    final client = MockClient((request) async {
      if (request.method == 'PUT') {
        putRequest = request;
        return jsonResponse(settingsFixture(dailyPostTarget: 3));
      }
      return jsonResponse(settingsFixture());
    });

    await pumpSettings(tester, client);

    await tester.tap(find.text('3 posts'));
    await settle(tester);

    // Find and tap the save button.
    await tester.ensureVisible(find.text('Save settings'));
    await tester.tap(find.text('Save settings'));
    await settle(tester);

    expect(putRequest, isNotNull);
    final body = jsonDecode(putRequest!.body) as Map<String, dynamic>;
    expect(body['dailyPostTarget'], 3);
    expect(body['dailyBudgetUsd'], isNull); // no configured budget
    expect(body['monthlyBudgetUsd'], isNull);
  });

  testWidgets('rejects a non-numeric budget before sending', (tester) async {
    final client = MockClient(
      (request) async => request.method == 'GET'
          ? jsonResponse(settingsFixture())
          : errorResponse(500, 'INTERNAL', 'unexpected'),
    );

    await pumpSettings(tester, client);

    // Find the daily budget field and enter an invalid value.
    final budgetField = find.ancestor(
      of: find.text('Daily budget (USD)'),
      matching: find.byType(TextFormField),
    );
    await tester.enterText(budgetField, 'abc');
    await settle(tester);

    await tester.ensureVisible(find.text('Save settings'));
    await tester.tap(find.text('Save settings'));
    await settle(tester);

    expect(
      find.textContaining('non-negative number'),
      findsWidgets,
    );
  });

  testWidgets('shows the backend-derived budgets when configured', (tester) async {
    final client = MockClient(
      (request) async => request.method == 'GET'
          ? jsonResponse(settingsFixture(
              dailyBudgetUsd: 5.0,
              monthlyBudgetUsd: 100.0,
            ))
          : errorResponse(500, 'INTERNAL', 'unexpected'),
    );

    await pumpSettings(tester, client);

    // The budget fields are pre-populated from the backend.
    expect(find.text('5'), findsOneWidget);
    expect(find.text('100'), findsOneWidget);
  });
}
