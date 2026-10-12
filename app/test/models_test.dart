import 'package:flutter_test/flutter_test.dart';
import 'package:shopee_affiliate_autopilot/models/api_models.dart';

void main() {
  group('HealthReport', () {
    test('parses a full backend /health payload', () {
      final json = <String, dynamic>{
        'status': 'ok',
        'version': '0.1.0',
        'part': 1,
        'uptimeSeconds': 123,
        'timestamp': '2026-10-12T00:42:33.671Z',
        'degradedReasons': ['Scheduler disabled'],
        'database': {
          'configured': false,
          'healthy': false,
          'detail': 'DATABASE_URL not set',
        },
        'scheduler': {
          'enabled': false,
          'mode': 'mock',
          'timezone': 'Asia/Jakarta',
          'intervalMinutes': 60,
          'maxSlotsPerDay': 24,
          'today': '2026-10-12',
          'slotsToday': 24,
          'nextSlot': {
            'key': '2026-10-12#09',
            'scheduledFor': '2026-10-12T01:00:00.000Z',
          },
          'message': 'Scheduler is disabled.',
        },
        'integrations': [
          {
            'service': 'facebook_page',
            'configured': false,
            'mode': 'disabled',
            'detail': 'Not configured',
          },
          {
            'service': 'threads',
            'configured': false,
            'mode': 'disabled',
            'detail': 'Not configured',
          },
        ],
      };

      final health = HealthReport.fromJson(json);

      expect(health.status, 'ok');
      expect(health.part, 1);
      expect(health.degradedReasons, ['Scheduler disabled']);
      expect(health.database.configured, false);
      expect(health.scheduler.timezone, 'Asia/Jakarta');
      expect(health.scheduler.intervalMinutes, 60);
      expect(health.scheduler.maxSlotsPerDay, 24);
      expect(health.scheduler.slotsToday, 24);
      expect(health.scheduler.nextSlot?.key, '2026-10-12#09');
      expect(health.integrations, hasLength(2));
      expect(health.integrations.first.service, 'facebook_page');
    });

    test('is resilient to a missing/empty payload', () {
      final health = HealthReport.fromJson(const {});
      expect(health.status, 'unknown');
      expect(health.part, 0);
      expect(health.integrations, isEmpty);
      expect(health.degradedReasons, isEmpty);
      expect(health.scheduler.nextSlot, isNull);
    });

    test('tolerates a null nextSlot', () {
      final health = HealthReport.fromJson({
        'scheduler': {
          'enabled': true,
          'nextSlot': null,
        },
      });
      expect(health.scheduler.nextSlot, isNull);
      expect(health.scheduler.enabled, isTrue);
    });
  });

  group('IntegrationStatus', () {
    test('parses a single entry', () {
      final s = IntegrationStatus.fromJson(const {
        'service': 'telegram',
        'configured': true,
        'mode': 'mock',
        'detail': 'in-memory',
      });
      expect(s.service, 'telegram');
      expect(s.configured, isTrue);
      expect(s.mode, 'mock');
    });

    test('never requires a secret field to exist', () {
      // A backend that leaks no secrets must parse fine with only these keys.
      final s = IntegrationStatus.fromJson(const {'service': 's3_storage'});
      expect(s.configured, isFalse);
      expect(s.detail, isEmpty);
    });
  });

  group('TokenResponse', () {
    test('parses an auth token payload', () {
      final t = TokenResponse.fromJson(const {
        'accessToken': 'aaa.bbb.ccc',
        'tokenType': 'Bearer',
        'expiresIn': 3600,
        'scope': ['dashboard', 'read'],
      });
      expect(t.accessToken, 'aaa.bbb.ccc');
      expect(t.tokenType, 'Bearer');
      expect(t.expiresIn, 3600);
      expect(t.scope, containsAll(['dashboard', 'read']));
    });
  });

  group('SchedulerStatus', () {
    test('parses slots and interval', () {
      final s = SchedulerStatus.fromJson(const {
        'enabled': true,
        'mode': 'mock',
        'timezone': 'Asia/Jakarta',
        'intervalMinutes': 60,
        'maxSlotsPerDay': 24,
        'today': '2026-10-12',
        'slotsToday': 24,
        'message': 'ok',
      });
      expect(s.enabled, isTrue);
      expect(s.slotsToday, 24);
      expect(s.maxSlotsPerDay, 24);
    });
  });

  group('JobRecord', () {
    test('parses a job with a nullable lastError', () {
      final j = JobRecord.fromJson(const {
        'id': 'abc',
        'kind': 'publish',
        'status': 'pending',
        'uniqueKey': '2026-10-12#01',
        'scheduledFor': '2026-10-12T00:00:00Z',
        'attempts': 0,
        'maxAttempts': 3,
        'lastError': null,
      });
      expect(j.uniqueKey, '2026-10-12#01');
      expect(j.lastError, isNull);
      expect(j.maxAttempts, 3);
    });
  });
}
