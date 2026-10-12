import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:shopee_affiliate_autopilot/models/automation_models.dart';
import 'package:shopee_affiliate_autopilot/screens/preview_screen.dart';

import 'helpers.dart';

/// PART 4 — preview screen + model contract for the mandatory editorial
/// policy, image-quality honesty, reference availability and the exact
/// `#ai #automation` ending.
///
/// Nothing here claims a live publication or a machine-verified fidelity
/// score: both are structurally impossible in this part.
void main() {
  setUp(seedSession);

  Future<void> pumpPreview(
    WidgetTester tester,
    MockClient mock, {
    VoidCallback? onSignedOut,
  }) async {
    await pumpSurface(
      tester,
      PreviewScreen(api: apiFrom(mock), onSignedOut: onSignedOut),
    );
    await settle(tester);
  }

  MockClient previewClient(Map<String, dynamic> payload) =>
      MockClient((request) async => jsonResponse(payload));

  Future<void> scrollTo(WidgetTester tester, Finder finder) async {
    await tester.dragUntilVisible(finder, find.byType(ListView), const Offset(0, -800));
  }

  /* ========================================================================== */
  /*  Model contract                                                            */
  /* ========================================================================== */

  group('ContentPreview PART 4 model contract', () {
    test('parses editorial + image-quality + reference blocks', () {
      final preview = ContentPreview.fromJson(pipelinePreviewFixture());

      expect(preview.editorial, isNotNull);
      expect(preview.editorial!.passed, isTrue);
      expect(preview.editorial!.mandatoryFinalHashtags, '#ai #automation');
      expect(preview.editorial!.mandatoryEndingPresent, isTrue);
      expect(preview.editorial!.disclosurePresent, isTrue);
      expect(preview.editorial!.limitations, contains('Not a substitute'));

      expect(preview.imageQuality, isNotNull);
      // The fidelity score is ALWAYS absent — never fabricated.
      expect(preview.imageQuality!.automatedFidelityScore, isNull);
      expect(preview.imageQuality!.limitations, contains('Structural checks only'));
      expect(preview.imageQuality!.notAssessed, isNotEmpty);
      expect(
        preview.imageQuality!.notAssessed.map((d) => d.dimension),
        contains('product_identity'),
      );

      expect(preview.product.referenceAvailable, isTrue);
      expect(preview.caption.mandatoryFinalHashtags, '#ai #automation');
      expect(preview.caption.hasMandatoryEnding, isTrue);
    });

    test('fixture payloads keep editorial/quality null (no invented data)', () {
      final fixture = ContentPreview.fromJson(previewFixture());

      expect(fixture.isFixture, isTrue);
      expect(fixture.editorial, isNull);
      expect(fixture.imageQuality, isNull);
      // The backend never reported reference availability for fixtures.
      expect(fixture.product.referenceAvailable, isNull);
      expect(fixture.caption.mandatoryFinalHashtags, isNull);
    });

    test('parses a failing editorial report with explicit rejected claims', () {
      final payload = pipelinePreviewFixture(
        stage: 'blocked',
        publishReady: false,
        editorialPassed: false,
        mandatoryEndingPresent: false,
        disclosurePresent: false,
        editorialBlocking: const [
          {
            'rule': 'editorial.no_first_person_claim',
            'message': 'Caption implies personal ownership of the product.',
          },
        ],
      );

      final preview = ContentPreview.fromJson(payload);
      expect(preview.editorial!.passed, isFalse);
      expect(preview.editorial!.blocking, hasLength(1));
      expect(preview.editorial!.blocking.first.rule, 'editorial.no_first_person_claim');
      expect(preview.editorial!.mandatoryEndingPresent, isFalse);
      expect(preview.editorial!.disclosurePresent, isFalse);
    });
  });

  /* ========================================================================== */
  /*  Screen rendering                                                          */
  /* ========================================================================== */

  group('PART 4 preview screen — editorial + quality + reference', () {
    testWidgets('shows the editorial policy result with the mandatory ending',
        (tester) async {
      await pumpPreview(tester, previewClient(pipelinePreviewFixture()));

      // The card sits below the fold: scroll it into the lazily-built list.
      await scrollTo(tester, find.text('Editorial policy'));
      expect(find.text('Editorial policy'), findsOneWidget);

      expect(find.text('Required ending'), findsOneWidget);
      expect(find.text('Ends with #ai #automation'), findsOneWidget);
      expect(find.text('Ending present'), findsOneWidget);
      expect(find.text('Affiliate disclosure'), findsOneWidget);
      expect(find.text('Present'), findsOneWidget);
      // Honest limitation: heuristics, not a human review.
      expect(find.textContaining('Not a substitute for human editorial review'),
          findsOneWidget);
    });

    testWidgets('surfaces rejected first-person claims when the policy fails',
        (tester) async {
      final blocked = pipelinePreviewFixture(
        stage: 'blocked',
        publishReady: false,
        editorialPassed: false,
        mandatoryEndingPresent: false,
        disclosurePresent: false,
        editorialBlocking: const [
          {
            'rule': 'editorial.no_first_person_claim',
            'message': 'Caption implies the account owner RECEIVED the product.',
          },
        ],
      );

      await pumpPreview(tester, previewClient(blocked));
      await scrollTo(tester, find.text('Editorial policy'));

      expect(find.text('Blocked'), findsAtLeastNWidgets(1));
      expect(find.text('Rejected claims:'), findsOneWidget);
      expect(
        find.textContaining('editorial.no_first_person_claim'),
        findsAtLeastNWidgets(1),
      );
      expect(find.textContaining('RECEIVED the product'), findsOneWidget);
      expect(find.text('Missing required ending #ai #automation'), findsOneWidget);
      expect(find.text('Missing'), findsAtLeastNWidgets(1)); // disclosure
    });

    testWidgets('never reports an automated fidelity score', (tester) async {
      await pumpPreview(tester, previewClient(pipelinePreviewFixture()));

      await scrollTo(tester, find.text('Image quality'));
      expect(find.text('Image quality'), findsOneWidget);

      expect(find.text('Automated fidelity score'), findsOneWidget);
      expect(find.text('Not available (never fabricated)'), findsOneWidget);
      expect(find.textContaining('Structural checks only'), findsOneWidget);
      // Dimensions that were NOT assessed are listed, not silently claimed.
      expect(find.textContaining('Not machine-verified'), findsOneWidget);
      expect(find.textContaining('product_identity'), findsOneWidget);
      // The score value itself is never rendered as a number.
      expect(find.textContaining('fidelity score: 0'), findsNothing);
    });

    testWidgets('shows reference availability for the reserved product',
        (tester) async {
      await pumpPreview(tester, previewClient(pipelinePreviewFixture()));

      expect(find.text('Reference image available'), findsOneWidget);
      expect(find.textContaining('Catalog id 1'), findsOneWidget);
      expect(find.text('Reference image MISSING'), findsNothing);
    });

    testWidgets('explains exactly why a missing reference blocks generation',
        (tester) async {
      final blocked = pipelinePreviewFixture(
        stage: 'blocked',
        publishReady: false,
        imageCount: 0,
        images: const [],
        referenceAvailable: false,
        referenceUnavailableReason:
            'The reserved product has no reference image; generation is blocked.',
        blockers: const [
          {
            'code': 'missing_reference_image',
            'message': 'The reserved product has no reference image.',
          },
        ],
      );

      await pumpPreview(tester, previewClient(blocked));

      expect(find.text('Reference image MISSING'), findsOneWidget);
      expect(
        find.textContaining('generation is blocked'),
        findsAtLeastNWidgets(1),
      );
    });

    testWidgets('PART 2 fixture payloads render without PART 4 sections',
        (tester) async {
      await pumpPreview(tester, previewClient(previewFixture()));

      expect(find.textContaining('Fixture content'), findsOneWidget);
      expect(find.text('Editorial policy'), findsNothing);
      expect(find.text('Image quality'), findsNothing);
      expect(find.text('Automated fidelity score'), findsNothing);
      expect(find.text('Reference image available'), findsNothing);
      expect(find.text('Reference image MISSING'), findsNothing);
      expect(find.text('Ends with #ai #automation'), findsNothing);
    });

    testWidgets('never claims a publication for PART 4 content', (tester) async {
      await pumpPreview(tester, previewClient(pipelinePreviewFixture()));
      await scrollTo(tester, find.text('Publication status'));

      expect(find.text('Not attempted'), findsNWidgets(2));
      expect(find.text('Published'), findsNothing);
    });
  });
}
