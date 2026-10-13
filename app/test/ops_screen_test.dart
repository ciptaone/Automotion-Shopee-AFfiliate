import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:shopee_affiliate_autopilot/models/ops_models.dart';
import 'package:shopee_affiliate_autopilot/screens/ops_screen.dart';

import 'helpers.dart';

/// PART 8 §5 — Ops dashboard rendering: overall status, readiness, per-status
/// chips, scheduler/queue diagnostics, the explicit publishing gate, recent
/// events, empty/error/offline states and the staleness marker.
///
/// All requests are served by MockClient — no socket, no AI credential, no
/// Telegram, no publication.
void main() {
  setUp(seedSession);

  testWidgets('renders the healthy overview with readiness and scheduler facts',
      (tester) async {
    final client = MockClient((request) async {
      expect(request.url.path, '/v1/ops/health');
      return jsonResponse(opsHealthFixture());
    });

    await pumpSurface(tester, OpsScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Overall status'), findsOneWidget);
    expect(find.text('Healthy'), findsWidgets);
    expect(find.text('Ready to accept generation work'), findsOneWidget);
    expect(find.textContaining('Asia/Jakarta'), findsWidgets);
    expect(find.textContaining('1/4 slots today'), findsOneWidget);
    expect(find.text('Up to date'), findsOneWidget);
  });

  testWidgets('flags NOT ready with blockers when the database is unreachable',
      (tester) async {
    final client = MockClient((request) async => jsonResponse(opsHealthFixture(
          overall: 'blocked',
          ready: false,
          blockers: const ['database_unreachable'],
          components: [
            opsComponentFixture('database', 'PostgreSQL', 'unavailable',
                code: 'database_unreachable',
                message: 'PostgreSQL is configured but not reachable.',
                criticality: 'required'),
            opsComponentFixture('publishing_gate', 'Publishing gate', 'disabled',
                code: 'publishing_disabled',
                message: 'Live publishing is disabled by design.',
                criticality: 'optional',
                data: {'facebook': 'disabled', 'threads': 'disabled'}),
          ],
        )));

    await pumpSurface(tester, OpsScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('NOT ready — generation work must not be sent'), findsOneWidget);
    expect(find.textContaining('database_unreachable'), findsOneWidget);
    expect(find.text('Blocked'), findsWidgets);
    expect(find.textContaining('PostgreSQL is configured but not reachable'), findsOneWidget);
  });

  testWidgets('shows the seven-status vocabulary distinctly', (tester) async {
    const statuses = [
      'healthy',
      'degraded',
      'blocked',
      'unavailable',
      'not_configured',
      'not_tested',
      'disabled',
    ];
    final client = MockClient((request) async => jsonResponse(opsHealthFixture(
          components: [
            for (var i = 0; i < statuses.length; i++)
              opsComponentFixture('comp_$i', 'Component $i', statuses[i],
                  code: 'code_$i'),
            opsComponentFixture('publishing_gate', 'Publishing gate', 'disabled',
                code: 'publishing_disabled',
                criticality: 'optional',
                data: {'facebook': 'disabled', 'threads': 'disabled'}),
          ],
        )));

    await pumpSurface(tester, OpsScreen(api: apiFrom(client)));
    await settle(tester);

    for (final label in const [
      'Healthy',
      'Degraded',
      'Blocked',
      'Unavailable',
      'Not configured',
      'Not tested',
      'Disabled',
    ]) {
      expect(find.text(label), findsWidgets, reason: 'status label $label');
    }
    expect(find.text('Component 3'), findsOneWidget);
  });

  testWidgets('renders queue counters, ages and expired leases', (tester) async {
    final client = MockClient((request) async => jsonResponse(opsHealthFixture(
          queue: {
            'pending': 3,
            'running': 1,
            'succeeded': 10,
            'failed': 2,
            'cancelled': 0,
            'retrying': 1,
            'oldestPendingAt': '2026-10-12T02:00:00.000Z',
            'oldestPendingAgeMs': 5400000, // 1h 30m
            'expiredLeases': 1,
          },
        )));

    await pumpSurface(tester, OpsScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Pending 3'), findsOneWidget);
    expect(find.text('Running 1'), findsOneWidget);
    expect(find.text('Retrying 1'), findsOneWidget);
    expect(find.text('Succeeded 10'), findsOneWidget);
    expect(find.text('Failed 2'), findsOneWidget);
    expect(find.text('Expired leases'), findsOneWidget);
    expect(find.text('1'), findsOneWidget);
    expect(find.text('Oldest pending'), findsOneWidget);
    expect(find.text('1h'), findsOneWidget);
  });

  testWidgets('publishing gate is always shown as disabled by design',
      (tester) async {
    final client = MockClient((request) async => jsonResponse(opsHealthFixture()));

    await pumpSurface(tester, OpsScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Publishing gate'), findsOneWidget);
    expect(
      find.textContaining('DISABLED by design'),
      findsOneWidget,
    );
    expect(find.textContaining('publish_ready'), findsOneWidget);
  });

  testWidgets('renders recent events with severity, occurrences and delivery',
      (tester) async {
    final client = MockClient((request) async => jsonResponse(opsHealthFixture(
          overall: 'degraded',
          recentEvents: [
            opsEventFixture(),
            opsEventFixture(
              fingerprint: 'budget_threshold',
              kind: 'budget_threshold',
              severity: 'warning',
              title: 'Daily budget at 92%',
              detail: null,
              occurrences: 1,
              lastDeliveryStatus: 'failed',
              lastErrorCode: 'rate_limited',
              lastMessageId: null,
              lastNotifiedAt: null,
            ),
          ],
        )));

    await pumpSurface(tester, OpsScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('Recent operational events'), findsOneWidget);
    expect(find.text('Scheduler tick failed'), findsOneWidget);
    expect(find.textContaining('boom'), findsOneWidget);
    expect(find.textContaining('×3'), findsOneWidget);
    expect(find.textContaining('delivery sent'), findsWidgets);
    expect(find.text('Daily budget at 92%'), findsOneWidget);
    expect(find.textContaining('rate_limited'), findsOneWidget);
  });

  testWidgets('shows the honest empty state when no events exist', (tester) async {
    final client = MockClient((request) async => jsonResponse(opsHealthFixture()));

    await pumpSurface(tester, OpsScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.text('No operational events'), findsOneWidget);
  });

  testWidgets('marks mock environments as development configuration',
      (tester) async {
    final client = MockClient((request) async => jsonResponse(opsHealthFixture(
          schedulerMode: 'mock',
        )));

    await pumpSurface(tester, OpsScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.textContaining('Development configuration'), findsOneWidget);
  });

  testWidgets('renders the full error state when the backend is unreachable',
      (tester) async {
    final client = MockClient(
        (request) async => throw const SocketException('down'));

    await pumpSurface(tester, OpsScreen(api: apiFrom(client)));
    await settle(tester);

    expect(find.textContaining('Backend unreachable'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
  });

  /* --- pure model + display-helper tests (no rendering) ------------------ */

  group('ops models', () {
    test('parses the full health report contract', () {
      final report = OpsHealthReport.fromJson(opsHealthFixture(
        overall: 'degraded',
        ready: false,
        blockers: const ['migration_drift'],
        recentEvents: [opsEventFixture()],
      ));

      expect(report.overall, 'degraded');
      expect(report.ready, isFalse);
      expect(report.blockers, const ['migration_drift']);
      expect(report.components, hasLength(11));
      expect(report.scheduler.dailyPostTarget, 4);
      expect(report.scheduler.timezone, 'Asia/Jakarta');
      expect(report.queue?.pending, 2);
      expect(report.recentEvents, hasLength(1));
      expect(report.recentEvents.first.severity, 'critical');
      expect(report.publishingGate?.code, 'publishing_disabled');
      expect(report.uptimeSeconds, 3600);
    });

    test('tolerates a missing scheduler/queue (partial payloads)', () {
      final report = OpsHealthReport.fromJson(const {
        'overall': 'not_tested',
        'ready': false,
        'components': <dynamic>[],
        'checkedAt': '2026-10-12T03:00:00.000Z',
      });
      expect(report.queue, isNull);
      expect(report.scheduler.enabled, isFalse);
      expect(report.publishingGate, isNull);
    });

    test('status helpers cover the locked vocabulary', () {
      expect(opsStatusLabel('not_configured'), 'Not configured');
      expect(opsStatusLabel(''), 'Unknown');
      expect(opsStatusColor('blocked'), isNot(opsStatusColor('healthy')));
      expect(opsStatusIcon('disabled'), Icons.pause_circle_outline_rounded);
    });

    test('staleness flips after the window and with no sync', () {
      final now = DateTime(2026, 10, 12, 12);
      expect(opsDataIsStale(null, now: now), isTrue);
      expect(
        opsDataIsStale(now.subtract(const Duration(seconds: 30)), now: now),
        isFalse,
      );
      expect(
        opsDataIsStale(now.subtract(const Duration(minutes: 5)), now: now),
        isTrue,
      );
    });

    test('age formatting is compact and bounded', () {
      expect(opsFormatAge(null), '—');
      expect(opsFormatAge(-5), '—');
      expect(opsFormatAge(30000), '30s');
      expect(opsFormatAge(5400000), '1h');
      expect(opsFormatAge(200 * 3600 * 1000), '8d');
    });
  });
}
