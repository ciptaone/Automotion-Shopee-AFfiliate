import 'package:flutter_test/flutter_test.dart';
import 'package:shopee_affiliate_autopilot/core/autopilot_api.dart';
import 'package:shopee_affiliate_autopilot/models/automation_models.dart';
import 'package:shopee_affiliate_autopilot/models/image_count_policy.dart';

import 'helpers.dart';

/// PART 3 — model parsing: selection mode, catalog payloads, and the
/// pipeline-preview fields (stage, images, blockers, providers,
/// publish-ready) with fixture payloads kept working.
void main() {
  group('SelectionMode', () {
    test('parses the wire values used by the backend', () {
      expect(SelectionMode.parse('auto'), SelectionMode.auto);
      expect(SelectionMode.parse('selected_categories'),
          SelectionMode.selectedCategories);
    });

    test('falls back to auto on unknown values', () {
      expect(SelectionMode.parse('chaos'), SelectionMode.auto);
      expect(SelectionMode.parse(null), SelectionMode.auto);
    });

    test('labels are human readable', () {
      expect(SelectionMode.auto.label, contains('Auto'));
      expect(SelectionMode.selectedCategories.label, contains('Selected'));
    });
  });

  group('AutomationSettings selection fields', () {
    test('mirrors the locked defaults', () {
      expect(AutomationSettings.defaults.selectionMode, SelectionMode.auto);
      expect(AutomationSettings.defaults.selectedCategoryIds, isEmpty);
    });

    test('round-trips selectionMode and selectedCategoryIds through JSON',
        () {
      const settings = AutomationSettings(
        intervalMinutes: 60,
        maxSlotsPerDay: 24,
        facebookEnabled: true,
        threadsEnabled: true,
        imageCountPolicy: ImageCountPolicy.defaultValue,
        telegramNotificationsEnabled: true,
        automationState: AutomationState.paused,
        selectionMode: SelectionMode.selectedCategories,
        selectedCategoryIds: ['home-living', 'health-beauty'],
      );

      final parsed =
          AutomationSettings.fromJson(settings.toJson());
      expect(parsed.selectionMode, SelectionMode.selectedCategories);
      expect(parsed.selectedCategoryIds, ['home-living', 'health-beauty']);
      expect(parsed.toJson(), settings.toJson());
    });

    test('tolerates a payload without the selection fields', () {
      final parsed = AutomationSettings.fromJson(const {
        'intervalMinutes': 45,
        'maxSlotsPerDay': 12,
      });
      expect(parsed.selectionMode, SelectionMode.auto);
      expect(parsed.selectedCategoryIds, isEmpty);
    });

    test('copyWith replaces the selection independently', () {
      final updated = AutomationSettings.defaults.copyWith(
        selectionMode: SelectionMode.selectedCategories,
        selectedCategoryIds: const ['fashion'],
      );
      expect(updated.selectionMode, SelectionMode.selectedCategories);
      expect(updated.selectedCategoryIds, ['fashion']);
      // Untouched values survive.
      expect(updated.intervalMinutes,
          AutomationSettings.defaults.intervalMinutes);
    });

    test('flags selected-categories mode with an empty selection', () {
      const empty = AutomationSettings(
        intervalMinutes: 60,
        maxSlotsPerDay: 24,
        facebookEnabled: true,
        threadsEnabled: true,
        imageCountPolicy: ImageCountPolicy.defaultValue,
        telegramNotificationsEnabled: true,
        automationState: AutomationState.paused,
        selectionMode: SelectionMode.selectedCategories,
        selectedCategoryIds: [],
      );
      expect(empty.selectionIssue, isNotNull);

      final filled = empty.copyWith(selectedCategoryIds: const ['fashion']);
      expect(filled.selectionIssue, isNull);

      expect(AutomationSettings.defaults.selectionIssue, isNull);
    });
  });

  group('CatalogCategoriesPayload', () {
    test('parses backend-derived categories with counts', () {
      final payload = CatalogCategoriesPayload.fromJson(
        catalogCategoriesFixture(),
      );
      expect(payload.count, 2);
      expect(payload.total, 5);
      expect(payload.isEmpty, isFalse);
      final health = payload.categories.first;
      expect(health.id, 'health-beauty');
      expect(health.name, 'Health & Beauty');
      expect(health.productCount, 3);
      expect(health.eligibleProductCount, 2);
      expect(payload.note, contains('actual imported catalog'));
    });

    test('an empty catalog parses as empty, never as a hardcoded list', () {
      final payload = CatalogCategoriesPayload.fromJson(
        catalogCategoriesFixture(categories: const [], total: 0),
      );
      expect(payload.categories, isEmpty);
      expect(payload.isEmpty, isTrue);
    });

    test('tolerates a missing payload', () {
      final payload = CatalogCategoriesPayload.fromJson(const {});
      expect(payload.categories, isEmpty);
      expect(payload.count, 0);
    });
  });

  group('CatalogStatusPayload', () {
    test('parses totals, storage and recent imports', () {
      final payload =
          CatalogStatusPayload.fromJson(catalogStatusFixture());
      expect(payload.total, 5);
      expect(payload.eligible, 4);
      expect(payload.categories, 2);
      expect(payload.storage, 'file');
      expect(payload.isEmpty, isFalse);
      expect(payload.recentImports.single.filename, 'feed.csv');
      expect(payload.recentImports.single.newProducts, 5);
    });

    test('reports an empty catalog honestly', () {
      final payload = CatalogStatusPayload.fromJson(
        catalogStatusFixture(total: 0, eligible: 0, categories: 0),
      );
      expect(payload.isEmpty, isTrue);
    });
  });

  group('PipelineStage', () {
    test('parses the wire values used by the backend', () {
      expect(PipelineStage.parse('publish_ready'), PipelineStage.publishReady);
      expect(PipelineStage.parse('blocked'), PipelineStage.blocked);
      expect(PipelineStage.parse('failed'), PipelineStage.failed);
      expect(PipelineStage.parse('generating_images'),
          PipelineStage.generatingImages);
    });

    test('falls back to reserved on unknown values', () {
      expect(PipelineStage.parse('wat'), PipelineStage.reserved);
      expect(PipelineStage.parse(null), PipelineStage.reserved);
    });

    test('only terminal stages are terminal', () {
      expect(PipelineStage.publishReady.isTerminal, isTrue);
      expect(PipelineStage.blocked.isTerminal, isTrue);
      expect(PipelineStage.failed.isTerminal, isTrue);
      expect(PipelineStage.generatingImages.isTerminal, isFalse);
    });
  });

  group('ContentPreview — pipeline payload', () {
    test('parses stage, images, providers and publish-ready', () {
      final preview = ContentPreview.fromJson(pipelinePreviewFixture());

      expect(preview.isPipeline, isTrue);
      expect(preview.isFixture, isFalse);
      expect(preview.stage, PipelineStage.publishReady);
      expect(preview.publishReady, isTrue);
      expect(preview.attempts, 1);
      expect(preview.generationRunId, 'run-0001');
      expect(preview.imageCountSource, 'pipeline_persisted');

      expect(preview.images, hasLength(2));
      final first = preview.images.first;
      expect(first.position, 1);
      expect(first.view, 'main_closeup_pov');
      expect(first.publicUrl, startsWith('https://'));
      expect(first.checksumSha256, hasLength(64));
      expect(first.promptVersion, 'part3-v1');
      expect(first.referenceImageUrl, isNotNull);
      expect(preview.images[1].view, 'secondary_lifestyle');

      expect(preview.providers?.image?.name, 'mock_image');
      expect(preview.providers?.image?.isMock, isTrue);
      expect(preview.usesMockProvider, isTrue);
      expect(preview.blockers, isEmpty);
    });

    test('parses exact blockers and marks the slot not publish-ready', () {
      final preview = ContentPreview.fromJson(pipelinePreviewFixture(
        stage: 'blocked',
        publishReady: false,
        blockers: const [
          {
            'code': 'missing_reference_image',
            'message': 'The reserved product has no reference image.',
          },
        ],
      ));

      expect(preview.stage, PipelineStage.blocked);
      expect(preview.publishReady, isFalse);
      expect(preview.blockers.single.code, 'missing_reference_image');
      expect(preview.blockers.single.message, contains('no reference image'));
    });

    test('a live-provider preview is not flagged as mock', () {
      final preview = ContentPreview.fromJson(pipelinePreviewFixture(
        imageProviderKind: 'live',
        captionProviderKind: 'live',
      ));
      expect(preview.usesMockProvider, isFalse);
      expect(preview.images.every((image) => image.isMock), isFalse);
    });

    test('a fixture preview still parses (PART 2 compatibility)', () {
      final preview = ContentPreview.fromJson(previewFixture(imageCount: 2));
      expect(preview.isFixture, isTrue);
      expect(preview.isPipeline, isFalse);
      expect(preview.stage, isNull);
      expect(preview.publishReady, isFalse);
      expect(preview.images, isEmpty);
      expect(preview.blockers, isEmpty);
      expect(preview.providers, isNull);
      expect(preview.imageCount, 2);
    });

    test('tolerates an empty payload', () {
      final preview = ContentPreview.fromJson(const {});
      expect(preview.isFixture, isFalse);
      expect(preview.stage, isNull);
      expect(preview.images, isEmpty);
      expect(preview.blockers, isEmpty);
    });
  });

  group('PipelineRunResult / PipelineSlotSummary', () {
    test('parses a run result wrapper', () {
      final result = PipelineRunResult.fromJson(const {
        'slotKey': '2026-10-12#01',
        'stage': 'publish_ready',
        'actions': ['reserve'],
        'preview': {},
        'note': 'Generation only.',
      });
      expect(result.slotKey, '2026-10-12#01');
      expect(result.stage, 'publish_ready');
      expect(result.actions, ['reserve']);
      expect(result.note, contains('Generation only'));
    });

    test('parses a slot summary', () {
      final slot = PipelineSlotSummary.fromJson(const {
        'slotKey': '2026-10-12#05',
        'stage': 'publish_ready',
        'productName': 'Synthetic Product 1',
        'imageCount': 2,
        'assets': 2,
        'captions': 2,
        'validationPassed': true,
        'blockers': <Map<String, dynamic>>[],
        'attempts': 1,
        'publishReady': true,
        'updatedAt': '2026-10-12T03:00:00.000Z',
      });
      expect(slot.slotKey, '2026-10-12#05');
      expect(slot.stage, 'publish_ready');
      expect(slot.productName, 'Synthetic Product 1');
      expect(slot.imageCount, 2);
      expect(slot.publishReady, isTrue);
      expect(slot.blockers, isEmpty);
    });
  });
}
