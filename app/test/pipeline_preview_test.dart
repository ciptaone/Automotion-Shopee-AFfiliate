import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:shopee_affiliate_autopilot/screens/preview_screen.dart';

import 'helpers.dart';

/// PART 3 — preview screen with REAL pipeline content:
/// pipeline vs fixture distinction, stage/blockers, generated images with
/// checksums and reference grounding, honest mock-provider labeling, the
/// publish gate, and the guarantee that nothing is ever shown as published.
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

  /* ========================================================================== */
  /*  Real pipeline content                                                     */
  /* ========================================================================== */

  testWidgets('renders a publish-ready pipeline slot with real images',
      (tester) async {
    await pumpPreview(tester, previewClient(pipelinePreviewFixture()));

    // Honest banner: real content, validated, publication still off.
    expect(find.textContaining('Real pipeline content'), findsOneWidget);
    expect(find.textContaining('publication is still switched off'), findsOneWidget);

    // Pipeline status card with the terminal success stage.
    expect(find.text('Pipeline status'), findsOneWidget);
    expect(find.text('Publish ready'), findsOneWidget);
    expect(find.text('publish_ready'), findsOneWidget);
    expect(find.text('Attempts'), findsOneWidget);
    expect(find.text('run-0001'), findsOneWidget);

    // Honest provider labeling.
    expect(find.text('mock_image (mock)'), findsOneWidget);
    expect(find.text('mock_caption (mock)'), findsOneWidget);
    expect(find.textContaining('Mock providers'), findsOneWidget);
    expect(find.textContaining('No paid call was made'), findsOneWidget);

    // Real generated images replace the fixture placeholders.
    expect(find.text('fixture placeholder'), findsNothing);
    expect(find.textContaining('Image 1 — main closeup pov'), findsOneWidget);
    expect(find.textContaining('Image 2 — secondary lifestyle'), findsOneWidget);
    expect(find.textContaining('part3-v1'), findsNWidgets(2));
    expect(find.textContaining('mock output'), findsNWidgets(2));
    expect(find.textContaining('Grounded on reference'), findsNWidgets(2));

    // Content source is explicit (top card, before scrolling).
    expect(find.text('Real pipeline record'), findsOneWidget);

    // Publish gate row (below the generated images — scroll to it).
    await tester.dragUntilVisible(
      find.textContaining('PASSED — ready to publish'),
      find.byType(ListView),
      const Offset(0, -800),
    );
    expect(find.textContaining('PASSED — ready to publish'), findsOneWidget);
  });

  testWidgets('a blocked slot shows the exact blockers and no images',
      (tester) async {
    final blocked = pipelinePreviewFixture(
      stage: 'blocked',
      publishReady: false,
      imageCount: 0,
      images: const [],
      blockers: const [
        {
          'code': 'no_eligible_products_in_selected_categories',
          'message': 'No eligible products in the selected categories.',
        },
      ],
    );

    await pumpPreview(tester, previewClient(blocked));

    expect(find.textContaining('BLOCKED'), findsOneWidget);
    expect(find.text('Exact blockers:'), findsOneWidget);
    // The code and message are surfaced in BOTH the pipeline card and the
    // validation card (the backend maps blockers into both).
    expect(find.textContaining('no_eligible_products_in_selected_categories'),
        findsAtLeastNWidgets(1));
    expect(
        find.textContaining('No eligible products in the selected categories'),
        findsAtLeastNWidgets(1));
    // Nothing can be published.
    expect(find.textContaining('NOT PASSED — nothing may be published'),
        findsOneWidget);
    // The image card explains there are no images instead of showing
    // placeholders.
    expect(find.text('fixture placeholder'), findsNothing);
    expect(find.textContaining('No images were generated for this slot'),
        findsOneWidget);
  });

  testWidgets('a failed slot is labeled as failed and retryable', (tester) async {
    final failed = pipelinePreviewFixture(
      stage: 'failed',
      publishReady: false,
      imageCount: 0,
      images: const [],
      blockers: const [
        {
          'code': 'image_generation_failed',
          'message': 'Image generation failed at position 1.',
        },
      ],
    );

    await pumpPreview(tester, previewClient(failed));

    expect(find.textContaining('FAILED'), findsOneWidget);
    expect(find.textContaining('Retry the slot'), findsOneWidget);
    expect(find.textContaining('image_generation_failed'),
        findsAtLeastNWidgets(1));
  });

  testWidgets('a live-provider run is not labeled as mock', (tester) async {
    final live = pipelinePreviewFixture(
      imageProviderKind: 'live',
      captionProviderKind: 'live',
    );

    await pumpPreview(tester, previewClient(live));

    expect(find.text('mock_image (mock)'), findsNothing);
    expect(find.textContaining('Mock providers'), findsNothing);
    expect(find.textContaining('live output'), findsNWidgets(2));
  });

  testWidgets('never claims anything was published', (tester) async {
    await pumpPreview(tester, previewClient(pipelinePreviewFixture()));

    // Scroll to the publication card at the bottom of the list.
    await tester.dragUntilVisible(
      find.text('Publication status'),
      find.byType(ListView),
      const Offset(0, -800),
    );

    expect(find.text('Not attempted'), findsNWidgets(2));
    expect(find.text('Published'), findsNothing);
    expect(find.textContaining('Publication is not enabled yet'), findsNWidgets(2));
  });

  testWidgets('shows a graceful message when a generated image URL is '
      'unreachable from this device', (tester) async {
    // flutter_test blocks network images: the tile must degrade honestly
    // instead of throwing or pretending the image loaded.
    await pumpPreview(tester, previewClient(pipelinePreviewFixture(imageCount: 1)));

    expect(find.textContaining('Image URL not reachable from this device'),
        findsOneWidget);
    // The metadata is still shown so the operator can verify the asset.
    expect(find.textContaining('sha256'), findsOneWidget);
  });

  /* ========================================================================== */
  /*  Fixture fallback (PART 2 behavior preserved)                              */
  /* ========================================================================== */

  testWidgets('still renders fixture content when no pipeline record exists',
      (tester) async {
    await pumpPreview(tester, previewClient(previewFixture()));

    expect(find.textContaining('Fixture content'), findsOneWidget);
    expect(find.text('Pipeline status'), findsNothing);
    expect(find.text('fixture placeholder'), findsNWidgets(2));
    expect(find.text('Fixture (no pipeline record for this slot)'), findsOneWidget);
    expect(find.text('Real pipeline content'), findsNothing);
    expect(find.textContaining('Publish gate'), findsNothing);
  });
}
