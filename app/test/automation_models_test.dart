import 'package:flutter_test/flutter_test.dart';
import 'package:shopee_affiliate_autopilot/core/autopilot_api.dart';
import 'package:shopee_affiliate_autopilot/models/automation_models.dart';
import 'package:shopee_affiliate_autopilot/models/image_count_policy.dart';

import 'helpers.dart';

void main() {
  group('ImageCountPolicy', () {
    test('parses the wire values used by the backend', () {
      expect(ImageCountPolicy.parse('random_1_or_2'), ImageCountPolicy.randomOneOrTwo);
      expect(ImageCountPolicy.parse('one'), ImageCountPolicy.one);
      expect(ImageCountPolicy.parse('two'), ImageCountPolicy.two);
    });

    test('falls back to the locked default on unknown values', () {
      expect(ImageCountPolicy.tryParse('random_1_to_9'), isNull);
      expect(ImageCountPolicy.parse('nope'), ImageCountPolicy.defaultValue);
      expect(ImageCountPolicy.parse(null), ImageCountPolicy.randomOneOrTwo);
      expect(ImageCountPolicy.defaultValue.wireValue, 'random_1_or_2');
    });

    test('validates backend-reported counts against policy bounds', () {
      expect(ImageCountPolicy.randomOneOrTwo.allows(1), isTrue);
      expect(ImageCountPolicy.randomOneOrTwo.allows(2), isTrue);
      expect(ImageCountPolicy.randomOneOrTwo.allows(3), isFalse);
      expect(ImageCountPolicy.one.allows(2), isFalse);
      expect(ImageCountPolicy.two.allows(1), isFalse);
    });

    test('labels are human readable', () {
      expect(ImageCountPolicy.randomOneOrTwo.label, contains('1-2'));
      expect(ImageCountPolicy.randomOneOrTwo.explanation, contains('per slot'));
    });
  });

  group('AutomationSettings', () {
    test('mirrors the locked defaults', () {
      expect(AutomationSettings.defaults.intervalMinutes, 60);
      expect(AutomationSettings.defaults.maxSlotsPerDay, 24);
      expect(AutomationSettings.defaults.imageCountPolicy, ImageCountPolicy.randomOneOrTwo);
      expect(AutomationSettings.defaults.facebookEnabled, isTrue);
      expect(AutomationSettings.defaults.threadsEnabled, isTrue);
      expect(AutomationSettings.defaults.automationState, AutomationState.paused);
    });

    test('round-trips through JSON', () {
      final settings = AutomationSettings.fromJson(const {
        'intervalMinutes': 90,
        'maxSlotsPerDay': 12,
        'facebookEnabled': false,
        'threadsEnabled': true,
        'imageCountPolicy': 'one',
        'telegramNotificationsEnabled': false,
        'automationState': 'running',
      });
      expect(settings.intervalMinutes, 90);
      expect(settings.imageCountPolicy, ImageCountPolicy.one);
      expect(settings.automationState, AutomationState.running);

      final back = AutomationSettings.fromJson(settings.toJson());
      expect(back.toJson(), settings.toJson());
    });

    test('tolerates a missing payload', () {
      final settings = AutomationSettings.fromJson(const {});
      expect(settings.intervalMinutes, 60);
      expect(settings.imageCountPolicy, ImageCountPolicy.randomOneOrTwo);
    });

    test('copyWith keeps untouched values', () {
      final updated = AutomationSettings.defaults.copyWith(intervalMinutes: 45);
      expect(updated.intervalMinutes, 45);
      expect(updated.maxSlotsPerDay, 24);
    });

    test('detects an impossible schedule client-side', () {
      expect(AutomationSettings.defaults.scheduleIssue, isNull);
      final impossible = AutomationSettings.defaults.copyWith(intervalMinutes: 360);
      expect(impossible.scheduleIssue, contains('24-hour day'));
    });
  });

  group('SettingsPayload', () {
    test('parses storage kind, warning and constraints', () {
      final payload = SettingsPayload.fromJson(settingsFixture(
        intervalMinutes: 45,
        warning: 'Settings file is invalid',
      ));
      expect(payload.settings.intervalMinutes, 45);
      expect(payload.storageKind, 'file');
      expect(payload.isPersisted, isTrue);
      expect(payload.warning, 'Settings file is invalid');
      expect(payload.constraints.maxSlotsPerDay, 24);
      expect(payload.constraints.imageCountPolicies, contains('random_1_or_2'));
    });

    test('reports in-memory storage as not persisted', () {
      final payload = SettingsPayload.fromJson(settingsFixture(storageKind: 'memory'));
      expect(payload.isPersisted, isFalse);
    });
  });

  group('ControlResult', () {
    test('parses action, changed flag and state', () {
      final result = ControlResult.fromJson(const {
        'action': 'pause',
        'changed': true,
        'state': 'paused',
        'settings': {'automationState': 'paused'},
        'note': 'Paused.',
      });
      expect(result.action, 'pause');
      expect(result.changed, isTrue);
      expect(result.state, AutomationState.paused);
    });
  });

  group('AutomationStatus', () {
    test('parses slots, counters and activity', () {
      final status = AutomationStatus.fromJson(automationStatusFixture(
        slotsUsed: 6,
        succeeded: 4,
        failed: 1,
        retrying: 1,
      ));
      expect(status.state, AutomationState.running);
      expect(status.slotsScheduled, 24);
      expect(status.slotsUsed, 6);
      expect(status.slotsRemaining, 18);
      expect(status.publications.succeeded, 4);
      expect(status.publications.failed, 1);
      expect(status.publications.source, 'job_queue');
      expect(status.recentActivity, hasLength(1));
      expect(status.recentActivity.first.uniqueKey, '2026-10-12#01');
    });

    test('reports an honest "nothing generated" state', () {
      final status = AutomationStatus.fromJson(automationStatusFixture());
      expect(status.latestContentNote, contains('not implemented'));
    });

    test('computes the slot fill ratio', () {
      final status = AutomationStatus.fromJson(automationStatusFixture(slotsUsed: 6));
      expect(status.slotFill, closeTo(0.25, 0.0001));
    });

    test('tolerates an empty payload', () {
      final status = AutomationStatus.fromJson(const {});
      expect(status.state, AutomationState.paused);
      expect(status.degraded, isFalse);
      expect(status.recentActivity, isEmpty);
    });
  });

  group('ContentPreview', () {
    test('parses a fixture preview with a single shared image count', () {
      final preview = ContentPreview.fromJson(previewFixture(imageCount: 2));
      expect(preview.isFixture, isTrue);
      expect(preview.imageCount, 2);
      expect(preview.imageCountPolicy, ImageCountPolicy.randomOneOrTwo);
      expect(preview.product.affiliateUrl, startsWith('https://'));
      expect(preview.caption.hashtags, isNotEmpty);
      expect(preview.validation.passed, isTrue);
      expect(preview.facebook.status, 'not_attempted');
      expect(preview.threads.status, 'not_attempted');
    });

    test('a one-image slot is represented as 1', () {
      final preview = ContentPreview.fromJson(previewFixture(imageCount: 1));
      expect(preview.imageCount, 1);
    });

    test('the contract carries exactly one image count, shared by both platforms', () {
      final json = previewFixture();
      expect(json.containsKey('imageCount'), isTrue);
      final platforms = json['platforms'] as Map<String, dynamic>;
      expect((platforms['facebook'] as Map<String, dynamic>).containsKey('imageCount'), isFalse);
      expect((platforms['threads'] as Map<String, dynamic>).containsKey('imageCount'), isFalse);
      // The client model exposes the same single count.
      final preview = ContentPreview.fromJson(json);
      expect(preview.imageCount, json['imageCount']);
    });

    test('parses a blocked validation report', () {
      final preview = ContentPreview.fromJson(previewFixture(validationPassed: false));
      expect(preview.validation.passed, isFalse);
      expect(preview.validation.blocking, isNotEmpty);
      expect(preview.validation.blocking.first.rule, contains('affiliate'));
    });
  });

  group('PublishRecord', () {
    test('keeps Facebook and Threads results independent', () {
      final history = PublishHistory.fromJson(historyFixture());
      expect(history.isFixture, isTrue);
      expect(history.items, hasLength(3));

      final mixed = history.items.firstWhere(
        (r) => r.facebook.published && r.threads.failed,
      );
      expect(mixed.facebook.url, isNotNull);
      expect(mixed.threads.error, isNotNull);
      expect(mixed.retry.pending, isTrue);

      final notAttempted = history.items.firstWhere((r) => r.threads.status == 'not_attempted');
      expect(notAttempted.facebook.failed, isTrue);
      expect(notAttempted.retry.exhausted, isTrue);
    });

    test('uses one image count for both platforms', () {
      final record = PublishHistory.fromJson(historyFixture()).items.first;
      expect(record.imageCount, 2);
    });

    test('tolerates an empty history payload', () {
      final history = PublishHistory.fromJson(const {});
      expect(history.items, isEmpty);
    });
  });

  group('IntegrationHealthEntry', () {
    test('maps service keys to display names', () {
      const entry = IntegrationHealthEntry(
        service: 'facebook_page',
        configured: false,
        mode: 'disabled',
        detail: 'not set',
        health: IntegrationHealth.disconnected,
        healthDetail: 'Not configured.',
      );
      expect(entry.displayName, 'Facebook Page');
    });

    test('parses health values and defaults safely', () {
      final entries = integrationsFixture().values.first as List<dynamic>;
      final parsed = entries
          .whereType<Map<String, dynamic>>()
          .map(IntegrationHealthEntry.fromJson)
          .toList();
      expect(parsed.map((e) => e.health), contains(IntegrationHealth.blocked));
      expect(parsed.map((e) => e.health), isNot(contains(IntegrationHealth.connected)));

      const unknown = IntegrationHealthEntry(
        service: 'x',
        configured: false,
        mode: '',
        detail: '',
        health: IntegrationHealth.disconnected,
        healthDetail: '',
      );
      expect(
        IntegrationHealthEntry.fromJson(const {'service': 'x', 'health': 'weird'}).health,
        unknown.health,
      );
    });
  });
}
