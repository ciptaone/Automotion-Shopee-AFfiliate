import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/autopilot_api.dart';
import '../core/backend_client.dart';
import '../models/automation_models.dart';
import '../widgets/common.dart';

/// Content preview: product, 1- or 2-image layout, caption + hashtags,
/// validation status and per-platform publication status.
///
/// HONESTY (Part 3): when the slot has a REAL pipeline record, this screen
/// renders it — stage, generated images, providers (mock vs live) and
/// blockers. When no pipeline record exists yet, the backend serves the Part 2
/// clearly-labelled FIXTURE content and this screen labels it as such.
/// Nothing here is ever published: the backend does not publish, and the
/// terminal success stage is `publish_ready`.
class PreviewScreen extends StatefulWidget {
  const PreviewScreen({super.key, required this.api, this.onSignedOut});

  final AutopilotApi api;
  final VoidCallback? onSignedOut;

  @override
  State<PreviewScreen> createState() => _PreviewScreenState();
}

class _PreviewScreenState extends State<PreviewScreen> {
  bool _loading = true;
  String? _error;
  ContentPreview? _preview;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = _preview == null;
      _error = null;
    });
    try {
      final preview = await widget.api.fetchContentPreview();
      if (!mounted) return;
      setState(() {
        _preview = preview;
        _loading = false;
      });
    } on AuthException {
      widget.onSignedOut?.call();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.message;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Content preview'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading && _preview == null) {
      return const LoadingState(label: 'Loading preview…');
    }
    final preview = _preview;
    if (preview == null) {
      return ErrorStateView(message: _error ?? 'No preview available.', onRetry: _load);
    }

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        children: [
          if (preview.isPipeline)
            _pipelineBanner(preview)
          else
            FixtureBanner(
              message: preview.note.isEmpty
                  ? 'Fixture content — nothing has been generated or published.'
                  : preview.note,
            ),
          if (_error != null) InlineErrorBanner(message: _error!, onRetry: _load),
          if (preview.isPipeline) _pipelineCard(preview),
          _slotCard(preview),
          _productCard(preview),
          _imagesCard(preview),
          if (preview.imageQuality != null) _imageQualityCard(preview),
          _captionCard(preview),
          if (preview.editorial != null) _editorialCard(preview),
          _validationCard(preview),
          _platformsCard(preview),
          const SizedBox(height: 24),
        ],
      ),
    );
  }

  /// Honest banner for REAL pipeline content: stage + provider kind.
  Widget _pipelineBanner(ContentPreview preview) {
    final scheme = Theme.of(context).colorScheme;
    final stage = preview.stage;
    final isReady = preview.publishReady;
    final color = isReady
        ? Colors.green
        : (stage == PipelineStage.blocked || stage == PipelineStage.failed)
            ? Colors.red
            : scheme.primary;
    final label = isReady
        ? 'Real pipeline content — validated and ready to publish '
            '(publication is still switched off).'
        : stage == PipelineStage.blocked
            ? 'Real pipeline content — BLOCKED. Nothing can be published.'
            : stage == PipelineStage.failed
                ? 'Real pipeline content — FAILED. Retry the slot.'
                : 'Real pipeline content — stage: ${stage?.wireValue ?? 'unknown'}.';
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withValues(alpha: 0.45)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(isReady ? Icons.verified_rounded : Icons.info_outline_rounded,
              size: 18, color: color),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              label,
              style: Theme.of(context)
                  .textTheme
                  .bodySmall
                  ?.copyWith(color: color, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }

  /// Stage, attempts, run id and exact blockers from the real pipeline record.
  Widget _pipelineCard(ContentPreview preview) {
    final scheme = Theme.of(context).colorScheme;
    final stage = preview.stage;
    final stageColor = preview.publishReady
        ? Colors.green
        : stage == PipelineStage.blocked || stage == PipelineStage.failed
            ? Colors.red
            : scheme.primary;
    final imageProvider = preview.providers?.image;
    final captionProvider = preview.providers?.caption;

    return SectionCard(
      title: 'Pipeline status',
      icon: Icons.route_rounded,
      trailing: StatusChip(
        label: preview.publishReady
            ? 'Publish ready'
            : stage?.wireValue.replaceAll('_', ' ') ?? 'unknown',
        color: stageColor,
        icon: preview.publishReady
            ? Icons.check_circle_rounded
            : Icons.timelapse_rounded,
      ),
      children: [
        KeyValueRow('Stage', stage?.wireValue ?? '—'),
        KeyValueRow('Attempts', '${preview.attempts}'),
        if (preview.generationRunId != null)
          KeyValueRow('Run id', preview.generationRunId!),
        KeyValueRow(
          'Image provider',
          imageProvider == null
              ? '—'
              : '${imageProvider.name} (${imageProvider.kind})',
        ),
        KeyValueRow(
          'Caption provider',
          captionProvider == null
              ? '—'
              : '${captionProvider.name} (${captionProvider.kind})',
        ),
        if (preview.usesMockProvider) ...[
          const SizedBox(height: 8),
          Text(
            'Mock providers: content was generated by the built-in offline '
            'mock, not a live AI service. No paid call was made.',
            style: Theme.of(context)
                .textTheme
                .bodySmall
                ?.copyWith(color: const Color(0xFF9A6B00)),
          ),
        ],
        if (preview.blockers.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text('Exact blockers:',
              style: Theme.of(context)
                  .textTheme
                  .titleSmall
                  ?.copyWith(fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          for (final blocker in preview.blockers)
            _IssueLine(
              rule: blocker.code,
              message: blocker.message,
              color: scheme.error,
            ),
        ],
        const SizedBox(height: 4),
        Text(
          preview.note.isEmpty
              ? 'Generation only. The backend never publishes to Facebook or '
                  'Threads in this part.'
              : preview.note,
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: scheme.onSurfaceVariant),
        ),
      ],
    );
  }

  Widget _slotCard(ContentPreview preview) {
    final scheme = Theme.of(context).colorScheme;
    return SectionCard(
      title: 'Content slot',
      icon: Icons.event_note_outlined,
      trailing: StatusChip(
        label: '${preview.imageCount} image${preview.imageCount == 1 ? '' : 's'}',
        color: scheme.primary,
        icon: Icons.photo_outlined,
      ),
      children: [
        KeyValueRow('Slot', preview.slotKey),
        KeyValueRow(
          'Content source',
          preview.isPipeline
              ? 'Real pipeline record'
              : 'Fixture (no pipeline record for this slot)',
        ),
        KeyValueRow('Image policy', preview.imageCountPolicy.label),
        KeyValueRow('Selected count', '${preview.imageCount} (shared by both platforms)'),
        KeyValueRow('Selection source', preview.imageCountSource),
        const SizedBox(height: 4),
        Text(
          'The count is chosen once per slot on the backend, so refreshing or '
          'retrying never changes it — and Facebook never gets a different '
          'count than Threads.',
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: scheme.onSurfaceVariant),
        ),
      ],
    );
  }

  Widget _productCard(ContentPreview preview) {
    final scheme = Theme.of(context).colorScheme;
    final referenceAvailable = preview.product.referenceAvailable;
    return SectionCard(
      title: 'Product',
      icon: Icons.shopping_bag_outlined,
      children: [
        Text(preview.product.name, style: Theme.of(context).textTheme.titleSmall),
        if (preview.product.sourceProductId != null) ...[
          const SizedBox(height: 4),
          Text(
            'Catalog id ${preview.product.sourceProductId}'
            '${preview.product.categoryId == null ? '' : ' · ${preview.product.categoryId}'}',
            style: Theme.of(context)
                .textTheme
                .bodySmall
                ?.copyWith(color: scheme.onSurfaceVariant),
          ),
        ],
        const SizedBox(height: 8),
        SelectableText(
          preview.product.affiliateUrl,
          style: TextStyle(
            fontSize: 13,
            color: scheme.primary,
          ),
        ),
        // PART 4: reference-image availability is always explicit — the
        // product record is the source of truth for image generation.
        if (referenceAvailable != null) ...[
          const SizedBox(height: 8),
          StatusChip(
            label: referenceAvailable ? 'Reference image available' : 'Reference image MISSING',
            color: referenceAvailable ? Colors.green : Colors.red,
            icon: referenceAvailable
                ? Icons.image_rounded
                : Icons.broken_image_outlined,
          ),
          if (!referenceAvailable && preview.product.referenceUnavailableReason != null) ...[
            const SizedBox(height: 6),
            Text(
              preview.product.referenceUnavailableReason!,
              style: Theme.of(context)
                  .textTheme
                  .bodySmall
                  ?.copyWith(color: scheme.error),
            ),
          ],
        ],
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.centerLeft,
          child: OutlinedButton.icon(
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: preview.product.affiliateUrl));
              if (!mounted) return;
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Affiliate URL copied.')),
              );
            },
            icon: const Icon(Icons.copy_rounded, size: 16),
            label: const Text('Copy affiliate URL'),
          ),
        ),
      ],
    );
  }

  Widget _imagesCard(ContentPreview preview) {
    final count = preview.imageCount;
    final realImages = preview.images;
    final scheme = Theme.of(context).colorScheme;

    return SectionCard(
      title: 'Images ($count)',
      icon: Icons.image_outlined,
      children: [
        if (realImages.isNotEmpty) ...[
          // REAL pipeline images: cURL-able URLs with checksums.
          for (final image in realImages) _GeneratedImageTile(image: image),
          const SizedBox(height: 8),
          Text(
            'Generated by ${preview.providers?.image?.name ?? 'pipeline'} '
            '(${preview.providers?.image?.kind ?? 'unknown'}). Images are '
            'validated structurally; visual fidelity to the product photo is '
            'not machine-scored yet.',
            style:
                Theme.of(context).textTheme.bodySmall?.copyWith(color: scheme.outline),
          ),
        ] else ...[
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: [
              for (var i = 1; i <= count; i++)
                _ImagePlaceholder(index: i, total: count),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            preview.isPipeline
                ? 'No images were generated for this slot — see the blockers '
                    'above for the exact reason.'
                : 'Placeholders: no real pipeline record exists for this slot, '
                    'so the backend served fixture content.',
            style:
                Theme.of(context).textTheme.bodySmall?.copyWith(color: scheme.outline),
          ),
        ],
      ],
    );
  }

  Widget _captionCard(ContentPreview preview) {
    final caption = preview.caption;
    final scheme = Theme.of(context).colorScheme;
    return SectionCard(
      title: 'Caption',
      icon: Icons.chat_bubble_outline_rounded,
      children: [
        SelectableText(caption.fullText, style: const TextStyle(fontSize: 13.5)),
        const SizedBox(height: 12),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final tag in caption.hashtags)
              Chip(
                label: Text(tag, style: const TextStyle(fontSize: 12)),
                visualDensity: VisualDensity.compact,
                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
          ],
        ),
        // PART 4: the mandatory tail is a hard rule — surface it explicitly.
        if (caption.mandatoryFinalHashtags != null) ...[
          const SizedBox(height: 8),
          StatusChip(
            label: caption.hasMandatoryEnding
                ? 'Ends with ${caption.mandatoryFinalHashtags}'
                : 'Missing required ending ${caption.mandatoryFinalHashtags}',
            color: caption.hasMandatoryEnding ? Colors.green : Colors.red,
            icon: caption.hasMandatoryEnding
                ? Icons.check_circle_rounded
                : Icons.cancel_rounded,
          ),
          const SizedBox(height: 4),
          Text(
            'The caption must end exactly with those hashtags, with nothing '
            'after them. The backend rejects and regenerates any caption that '
            'does not.',
            style: Theme.of(context)
                .textTheme
                .bodySmall
                ?.copyWith(color: scheme.onSurfaceVariant),
          ),
        ],
      ],
    );
  }

  /// PART 4 — structured editorial policy result (claims, disclosure, ending).
  Widget _editorialCard(ContentPreview preview) {
    final editorial = preview.editorial!;
    final scheme = Theme.of(context).colorScheme;
    return SectionCard(
      title: 'Editorial policy',
      icon: Icons.rule_rounded,
      trailing: StatusChip(
        label: editorial.passed ? 'Passed' : 'Blocked',
        color: editorial.passed ? Colors.green : Colors.red,
        icon: editorial.passed ? Icons.check_rounded : Icons.block_rounded,
      ),
      children: [
        KeyValueRow('Engine', editorial.source),
        KeyValueRow('Required ending', editorial.mandatoryFinalHashtags),
        KeyValueRow(
          'Ending present',
          editorial.mandatoryEndingPresent ? 'Yes' : 'No',
        ),
        KeyValueRow(
          'Affiliate disclosure',
          editorial.disclosurePresent ? 'Present' : 'Missing',
        ),
        if (editorial.blocking.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text('Rejected claims:',
              style: Theme.of(context)
                  .textTheme
                  .titleSmall
                  ?.copyWith(fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          for (final issue in editorial.blocking)
            _IssueLine(rule: issue.rule, message: issue.message, color: scheme.error),
        ],
        if (editorial.warnings.isNotEmpty) ...[
          const SizedBox(height: 8),
          for (final issue in editorial.warnings)
            _IssueLine(
              rule: issue.rule,
              message: issue.message,
              color: const Color(0xFF9A6B00),
            ),
        ],
        if (editorial.limitations.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text(
            editorial.limitations,
            style: Theme.of(context)
                .textTheme
                .bodySmall
                ?.copyWith(color: scheme.onSurfaceVariant),
          ),
        ],
      ],
    );
  }

  /// PART 4 — structural image quality. The fidelity score is ALWAYS absent
  /// (no vision scorer), and the screen says so instead of inventing one.
  Widget _imageQualityCard(ContentPreview preview) {
    final quality = preview.imageQuality!;
    final scheme = Theme.of(context).colorScheme;
    return SectionCard(
      title: 'Image quality',
      icon: Icons.high_quality_outlined,
      trailing: StatusChip(
        label: quality.passed ? 'Structural checks passed' : 'Structural problems found',
        color: quality.passed ? Colors.green : Colors.red,
        icon: quality.passed ? Icons.check_rounded : Icons.block_rounded,
      ),
      children: [
        KeyValueRow('Engine', quality.source),
        KeyValueRow(
          'Automated fidelity score',
          quality.automatedFidelityScore == null
              ? 'Not available (never fabricated)'
              : '${quality.automatedFidelityScore}',
        ),
        if (quality.blocking.isNotEmpty) ...[
          const SizedBox(height: 8),
          for (final issue in quality.blocking)
            _IssueLine(rule: issue.rule, message: issue.message, color: scheme.error),
        ],
        if (quality.notAssessed.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text(
            'Not machine-verified: ${quality.notAssessed.map((d) => d.dimension).join(', ')}.',
            style: Theme.of(context)
                .textTheme
                .bodySmall
                ?.copyWith(color: const Color(0xFF9A6B00)),
          ),
        ],
        if (quality.limitations.isNotEmpty) ...[
          const SizedBox(height: 6),
          Text(
            quality.limitations,
            style: Theme.of(context)
                .textTheme
                .bodySmall
                ?.copyWith(color: scheme.onSurfaceVariant),
          ),
        ],
      ],
    );
  }

  Widget _validationCard(ContentPreview preview) {
    final validation = preview.validation;
    final scheme = Theme.of(context).colorScheme;
    return SectionCard(
      title: 'Validation',
      icon: Icons.fact_check_outlined,
      trailing: StatusChip(
        label: validation.passed ? 'Passed' : 'Blocked',
        color: validation.passed ? Colors.green : Colors.red,
        icon: validation.passed ? Icons.check_rounded : Icons.block_rounded,
      ),
      children: [
        KeyValueRow('Rules engine', validation.source),
        KeyValueRow(
          'Checked for',
          validation.platformsChecked.isEmpty
              ? '—'
              : validation.platformsChecked.join(', '),
        ),
        if (preview.isPipeline)
          KeyValueRow(
            'Publish gate',
            preview.publishReady
                ? 'PASSED — ready to publish (publication still off)'
                : 'NOT PASSED — nothing may be published',
          ),
        if (validation.blocking.isNotEmpty) ...[
          const SizedBox(height: 8),
          for (final issue in validation.blocking)
            _IssueLine(rule: issue.rule, message: issue.message, color: scheme.error),
        ],
        if (validation.warnings.isNotEmpty) ...[
          const SizedBox(height: 8),
          for (final issue in validation.warnings)
            _IssueLine(
              rule: issue.rule,
              message: issue.message,
              color: const Color(0xFF9A6B00),
            ),
        ],
        if (validation.blocking.isEmpty && validation.warnings.isEmpty)
          Text(
            'All publish-gate rules passed for this content.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
      ],
    );
  }

  Widget _platformsCard(ContentPreview preview) {
    return SectionCard(
      title: 'Publication status',
      icon: Icons.public_rounded,
      children: [
        _PlatformRow(
          label: 'Facebook Page',
          icon: Icons.facebook_rounded,
          status: preview.facebook,
        ),
        const Divider(height: 16),
        _PlatformRow(
          label: 'Threads',
          icon: Icons.alternate_email_rounded,
          status: preview.threads,
        ),
        const SizedBox(height: 4),
        Text(
          'Both platforms share the same caption and the same ${preview.imageCount} '
          'image(s) for this slot.',
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
      ],
    );
  }
}

class _ImagePlaceholder extends StatelessWidget {
  const _ImagePlaceholder({required this.index, required this.total});

  final int index;
  final int total;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: 150,
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: scheme.outlineVariant),
      ),
      padding: const EdgeInsets.all(12),
      child: Column(
        children: [
          Icon(Icons.image_outlined, size: 34, color: scheme.outline),
          const SizedBox(height: 8),
          Text(
            'Image $index of $total',
            style: Theme.of(context).textTheme.labelLarge,
          ),
          const SizedBox(height: 2),
          Text(
            'fixture placeholder',
            style: Theme.of(context)
                .textTheme
                .labelSmall
                ?.copyWith(color: scheme.outline),
          ),
        ],
      ),
    );
  }
}

class _GeneratedImageTile extends StatelessWidget {
  const _GeneratedImageTile({required this.image});

  final PipelineImage image;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: AspectRatio(
              aspectRatio: image.height > 0 ? image.width / image.height : 9 / 16,
              child: Image.network(
                image.publicUrl,
                fit: BoxFit.cover,
                errorBuilder: (context, error, stack) => Container(
                  color: scheme.surfaceContainerHighest,
                  alignment: Alignment.center,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.broken_image_outlined, color: scheme.outline),
                      const SizedBox(height: 6),
                      Text(
                        'Image URL not reachable from this device.',
                        style: Theme.of(context)
                            .textTheme
                            .bodySmall
                            ?.copyWith(color: scheme.outline),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'Image ${image.position} — ${image.view.replaceAll('_', ' ')}',
            style: Theme.of(context)
                .textTheme
                .titleSmall
                ?.copyWith(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 2),
          Text(
            '${image.width}×${image.height} · ${image.model} · '
            'prompt ${image.promptVersion}',
            style: Theme.of(context)
                .textTheme
                .bodySmall
                ?.copyWith(color: scheme.onSurfaceVariant),
          ),
          Text(
            'sha256 ${image.checksumSha256.substring(0, 16)}… · '
            '${image.isMock ? 'mock output' : 'live output'}',
            style: Theme.of(context)
                .textTheme
                .bodySmall
                ?.copyWith(color: scheme.outline),
          ),
          if (image.referenceImageUrl != null) ...[
            const SizedBox(height: 2),
            Text(
              'Grounded on reference: ${image.referenceImageUrl}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context)
                  .textTheme
                  .bodySmall
                  ?.copyWith(color: scheme.outline, fontSize: 11),
            ),
          ],
        ],
      ),
    );
  }
}

class _IssueLine extends StatelessWidget {
  const _IssueLine({required this.rule, required this.message, required this.color});

  final String rule;
  final String message;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.error_outline_rounded, size: 14, color: color),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              '$rule — $message',
              style: TextStyle(fontSize: 12.5, color: color),
            ),
          ),
        ],
      ),
    );
  }
}

class _PlatformRow extends StatelessWidget {
  const _PlatformRow({required this.label, required this.icon, required this.status});

  final String label;
  final IconData icon;
  final PreviewPlatformStatus status;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (color, chipLabel) = switch (status.status) {
      'published' => (Colors.green, 'Published'),
      'failed' => (Colors.red, 'Failed'),
      _ => (Colors.grey, status.enabled ? 'Not attempted' : 'Disabled'),
    };
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 18, color: scheme.primary),
        const SizedBox(width: 8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5)),
              if (status.detail.isNotEmpty)
                Text(
                  status.detail,
                  style: Theme.of(context)
                      .textTheme
                      .bodySmall
                      ?.copyWith(color: scheme.onSurfaceVariant),
                ),
              if (status.url != null)
                SelectableText(
                  status.url!,
                  style: TextStyle(fontSize: 12, color: scheme.primary),
                ),
            ],
          ),
        ),
        StatusChip(label: chipLabel, color: color),
      ],
    );
  }
}
