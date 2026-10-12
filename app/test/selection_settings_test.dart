import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shopee_affiliate_autopilot/screens/settings_screen.dart';

import 'helpers.dart';

/// PART 3 — product-selection settings UI:
/// Auto vs Selected-Categories mode, backend-sourced category multi-select,
/// empty-catalog messaging, category loading/error states, and the guarantee
/// that an empty selection is never silently sent (and never falls back).
void main() {
  setUp(seedSession);

  /// Routes: GET settings, GET categories, PUT settings — recorded for
  /// assertions.
  MockClient client({
    Map<String, dynamic>? settings,
    Map<String, dynamic>? categories,
    http.Response? Function(http.Request request)? onPut,
    bool categoriesFail = false,
  }) =>
      MockClient((request) async {
        if (request.method == 'PUT' && onPut != null) {
          final captured = onPut(request);
          if (captured != null) return captured;
        }
        final path = request.url.path;
        if (path == '/v1/catalog/categories') {
          if (categoriesFail) {
            return errorResponse(500, 'CATALOG_CATEGORIES_FAILED', 'boom');
          }
          return jsonResponse(categories ?? catalogCategoriesFixture());
        }
        return jsonResponse(
          settings ?? settingsFixture(),
        );
      });

  Future<void> pumpSettings(
    WidgetTester tester,
    MockClient mock, {
    VoidCallback? onSignedOut,
  }) async {
    await pumpSurface(
      tester,
      SettingsScreen(api: apiFrom(mock), onSignedOut: onSignedOut),
    );
    await settle(tester);
  }

  testWidgets('shows the selection mode with Auto active by default', (tester) async {
    await pumpSettings(tester, client());

    expect(find.text('Product selection'), findsOneWidget);
    expect(find.text('Auto (all eligible categories)'), findsOneWidget);
    expect(find.text('Selected categories only'), findsOneWidget);
    // Auto mode explains the weighted-scoring policy and disclaims predictions.
    expect(find.textContaining('weighted scoring'), findsOneWidget);
    expect(find.textContaining('no sales predictions'), findsOneWidget);
    // No category checkboxes while Auto is active.
    expect(find.byType(CheckboxListTile), findsNothing);
  });

  testWidgets(
      'switching to Selected Categories reveals backend-derived categories',
      (tester) async {
    await pumpSettings(tester, client());

    await tester.tap(find.text('Selected categories only'));
    await settle(tester);

    expect(find.text('Health & Beauty'), findsOneWidget);
    expect(find.text('Home & Living'), findsOneWidget);
    // Real counts from the catalog, not invented numbers.
    expect(find.text('2 eligible of 3 imported'), findsOneWidget);
    expect(find.text('2 eligible of 2 imported'), findsOneWidget);
    expect(find.byType(CheckboxListTile), findsNWidgets(2));
    // The no-selection warning is visible before anything is picked.
    expect(find.textContaining('never silently'), findsOneWidget);
  });

  testWidgets('sends the picked categories through PUT /v1/settings',
      (tester) async {
    http.Request? putRequest;
    final mock = client(
      onPut: (request) {
        putRequest = request;
        return jsonResponse(settingsFixture(
          selectionMode: 'selected_categories',
          selectedCategoryIds: ['home-living'],
        ));
      },
    );

    await pumpSettings(tester, mock);

    await tester.tap(find.text('Selected categories only'));
    await settle(tester);
    await tester.ensureVisible(find.text('Home & Living'));
    await tester.tap(find.text('Home & Living'));
    await settle(tester, frames: 2);

    await tester.ensureVisible(find.text('Save settings'));
    await tester.tap(find.text('Save settings'));
    await settle(tester);

    expect(putRequest, isNotNull);
    final body = jsonDecode(putRequest!.body) as Map<String, dynamic>;
    expect(body['selectionMode'], 'selected_categories');
    expect(body['selectedCategoryIds'], ['home-living']);
  });

  testWidgets('auto mode always sends an EMPTY category list', (tester) async {
    http.Request? putRequest;
    final mock = client(
      onPut: (request) {
        putRequest = request;
        return jsonResponse(settingsFixture());
      },
    );

    await pumpSettings(tester, mock);

    // Round-trip: peek at Selected, pick something, go back to Auto, save.
    await tester.tap(find.text('Selected categories only'));
    await settle(tester);
    await tester.ensureVisible(find.text('Health & Beauty'));
    await tester.tap(find.text('Health & Beauty'));
    await settle(tester, frames: 2);
    await tester.tap(find.text('Auto (all eligible categories)'));
    await settle(tester);

    await tester.ensureVisible(find.text('Save settings'));
    await tester.tap(find.text('Save settings'));
    await settle(tester);

    final body = jsonDecode(putRequest!.body) as Map<String, dynamic>;
    expect(body['selectionMode'], 'auto');
    expect(body['selectedCategoryIds'], isEmpty);
  });

  testWidgets('refuses to save Selected Categories with nothing selected',
      (tester) async {
    var putCalls = 0;
    final mock = client(
      onPut: (request) {
        putCalls += 1;
        return jsonResponse(settingsFixture());
      },
    );

    await pumpSettings(tester, mock);

    await tester.tap(find.text('Selected categories only'));
    await settle(tester);

    await tester.ensureVisible(find.text('Save settings'));
    await tester.tap(find.text('Save settings'));
    await settle(tester);

    expect(putCalls, 0, reason: 'an empty selection is never sent to the backend');
    expect(find.textContaining('Select at least one category'), findsOneWidget);
  });

  testWidgets('renders a pre-selected backend selection as checked', (tester) async {
    final mock = client(
      settings: settingsFixture(
        selectionMode: 'selected_categories',
        selectedCategoryIds: ['home-living'],
      ),
    );

    await pumpSettings(tester, mock);

    // Selected mode active without any tap.
    expect(find.text('Pick one or more categories (only these will be used):'),
        findsOneWidget);
    final homeTile = tester.widget<CheckboxListTile>(
      find.ancestor(
        of: find.text('Home & Living'),
        matching: find.byType(CheckboxListTile),
      ),
    );
    final healthTile = tester.widget<CheckboxListTile>(
      find.ancestor(
        of: find.text('Health & Beauty'),
        matching: find.byType(CheckboxListTile),
      ),
    );
    expect(homeTile.value, isTrue);
    expect(healthTile.value, isFalse);
  });

  testWidgets('shows empty-catalog guidance instead of invented categories',
      (tester) async {
    final mock = client(
      categories: catalogCategoriesFixture(categories: const [], total: 0),
    );

    await pumpSettings(tester, mock);

    await tester.tap(find.text('Selected categories only'));
    await settle(tester);

    expect(find.textContaining('catalog is empty'), findsOneWidget);
    expect(find.textContaining('POST /v1/catalog/import'), findsOneWidget);
    // Never a hardcoded category list.
    expect(find.text('Health & Beauty'), findsNothing);
    expect(find.byType(CheckboxListTile), findsNothing);
  });

  testWidgets('shows a retry state when categories fail to load', (tester) async {
    var categoryCalls = 0;
    final mock = MockClient((request) async {
      if (request.url.path == '/v1/catalog/categories') {
        categoryCalls += 1;
        if (categoryCalls == 1) {
          return errorResponse(500, 'CATALOG_CATEGORIES_FAILED', 'boom');
        }
        return jsonResponse(catalogCategoriesFixture());
      }
      return jsonResponse(settingsFixture());
    });

    await pumpSettings(tester, mock);

    await tester.tap(find.text('Selected categories only'));
    await settle(tester);

    expect(find.textContaining('Categories failed to load'), findsOneWidget);

    await tester.ensureVisible(find.text('Retry'));
    await tester.tap(find.text('Retry'));
    await settle(tester);

    expect(categoryCalls, 2);
    expect(find.text('Health & Beauty'), findsOneWidget);
  });

  testWidgets('drops selection ids that no longer exist in the catalog',
      (tester) async {
    http.Request? putRequest;
    final mock = client(
      // Backend still holds a stale id from an older import.
      settings: settingsFixture(
        selectionMode: 'selected_categories',
        selectedCategoryIds: ['ghost-category', 'home-living'],
      ),
      onPut: (request) {
        putRequest = request;
        return jsonResponse(settingsFixture(
          selectionMode: 'selected_categories',
          selectedCategoryIds: ['home-living'],
        ));
      },
    );

    await pumpSettings(tester, mock);

    // The stale id is pruned; only the two real categories are listed.
    expect(find.byType(CheckboxListTile), findsNWidgets(2));

    // Mark the form dirty (the Save button stays disabled otherwise).
    await tester.enterText(find.byType(TextFormField).at(0), '45');
    await settle(tester, frames: 2);

    await tester.ensureVisible(find.text('Save settings'));
    await tester.tap(find.text('Save settings'));
    await settle(tester);

    expect(putRequest, isNotNull);
    final body = jsonDecode(putRequest!.body) as Map<String, dynamic>;
    expect(body['selectedCategoryIds'], ['home-living']);
    expect(body['selectionMode'], 'selected_categories');
  });

  testWidgets('never renders credential-looking strings', (tester) async {
    final mock = client();
    await pumpSettings(tester, mock);

    final materialApp = tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(materialApp, isNotNull);
    // The category payload and settings contain no secret-looking values.
    expect(find.textContaining('secret'), findsNothing);
    expect(find.textContaining('password'), findsNothing);
    expect(find.textContaining('api_key'), findsNothing);
  });
}
