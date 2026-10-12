import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/autopilot_api.dart';
import '../core/backend_client.dart';
import '../models/automation_models.dart';
import '../widgets/common.dart';

/// Content preview: product, 1- or 2-image layout, caption + hashtags,
/// validation status and per-platform publication status.
///
/// HONESTY: the generation pipeline does not exist yet, so the backend serves
/// clearly-labelled FIXTURE content. The image count shown is the ONE count the
/// backend selected for the slot — it is shared by Facebook and Threads and
/// stays stable when the same slot is refreshed.
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
          FixtureBanner(
            message: preview.note.isEmpty
                ? 'Fixture content — nothing has been generated or published.'
                : preview.note,
          ),
          if (_error != null) InlineErrorBanner(message: _error!, onRetry: _load),
          _slotCard(preview),
          _productCard(preview),
          _imagesCard(preview),
          _captionCard(preview),
          _validationCard(preview),
          _platformsCard(preview),
          const SizedBox(height: 24),
        ],
      ),
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
    return SectionCard(
      title: 'Product',
      icon: Icons.shopping_bag_outlined,
      children: [
        Text(preview.product.name, style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: 8),
        SelectableText(
          preview.product.affiliateUrl,
          style: TextStyle(
            fontSize: 13,
            color: Theme.of(context).colorScheme.primary,
          ),
        ),
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
    return SectionCard(
      title: 'Images ($count)',
      icon: Icons.image_outlined,
      children: [
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: [
            for (var i = 1; i <= count; i++) _ImagePlaceholder(index: i, total: count),
          ],
        ),
        const SizedBox(height: 8),
        Text(
          'Placeholders: image generation is implemented on the backend in a later '
          'part, so no generated image is shown here.',
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: Theme.of(context).colorScheme.outline),
        ),
      ],
    );
  }

  Widget _captionCard(ContentPreview preview) {
    return SectionCard(
      title: 'Caption',
      icon: Icons.chat_bubble_outline_rounded,
      children: [
        SelectableText(preview.caption.fullText, style: const TextStyle(fontSize: 13.5)),
        const SizedBox(height: 12),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final tag in preview.caption.hashtags)
              Chip(
                label: Text(tag, style: const TextStyle(fontSize: 12)),
                visualDensity: VisualDensity.compact,
                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
          ],
        ),
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
