import 'package:flutter/material.dart';

import '../core/autopilot_api.dart';
import '../core/backend_client.dart';
import '../models/automation_models.dart';
import '../widgets/common.dart';

/// Publishing history: timestamp, product, image count, INDEPENDENT Facebook and
/// Threads results, post links when available, error summary and retry status.
///
/// The backend currently serves clearly-labelled fixture records because no
/// publication pipeline exists yet.
class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key, required this.api, this.onSignedOut});

  final AutopilotApi api;
  final VoidCallback? onSignedOut;

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  bool _loading = true;
  String? _error;
  PublishHistory? _history;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = _history == null;
      _error = null;
    });
    try {
      final history = await widget.api.fetchPublishHistory();
      if (!mounted) return;
      setState(() {
        _history = history;
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
        title: const Text('Publishing history'),
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
    if (_loading && _history == null) {
      return const LoadingState(label: 'Loading history…');
    }
    final history = _history;
    if (history == null) {
      return ErrorStateView(message: _error ?? 'No history available.', onRetry: _load);
    }

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        children: [
          FixtureBanner(message: history.note.isEmpty ? 'Fixture records.' : history.note),
          if (_error != null) InlineErrorBanner(message: _error!, onRetry: _load),
          if (history.items.isEmpty)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: EmptyStateView(
                  icon: Icons.history_toggle_off_rounded,
                  title: 'No publications yet',
                  message:
                      'Records appear once the backend actually publishes a content slot.',
                ),
              ),
            ),
          for (final record in history.items) _RecordCard(record: record),
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}

class _RecordCard extends StatelessWidget {
  const _RecordCard({required this.record});

  final PublishRecord record;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final errors = [
      if (record.facebook.error != null) 'Facebook: ${record.facebook.error}',
      if (record.threads.error != null) 'Threads: ${record.threads.error}',
    ];

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    record.productName,
                    style: Theme.of(context).textTheme.titleSmall,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                StatusChip(
                  label: '${record.imageCount} img',
                  color: scheme.primary,
                  icon: Icons.photo_outlined,
                  tooltip: 'One count shared by both platforms.',
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              '${_formatTimestamp(record.publishedAt)}  ·  slot ${record.slotKey}',
              style: Theme.of(context)
                  .textTheme
                  .labelSmall
                  ?.copyWith(color: scheme.onSurfaceVariant),
            ),
            const Divider(height: 18),
            _ResultRow(label: 'Facebook Page', icon: Icons.facebook_rounded, result: record.facebook),
            const SizedBox(height: 8),
            _ResultRow(label: 'Threads', icon: Icons.alternate_email_rounded, result: record.threads),
            if (errors.isNotEmpty) ...[
              const SizedBox(height: 10),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: scheme.errorContainer.withValues(alpha: 0.5),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Error summary',
                      style: Theme.of(context)
                          .textTheme
                          .labelMedium
                          ?.copyWith(color: scheme.onErrorContainer),
                    ),
                    for (final error in errors)
                      Text(
                        error,
                        style: TextStyle(fontSize: 12.5, color: scheme.onErrorContainer),
                      ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 8),
            Row(
              children: [
                Icon(Icons.replay_rounded, size: 14, color: scheme.onSurfaceVariant),
                const SizedBox(width: 6),
                Text(
                  'Retry: ${record.retry.status} '
                  '(${record.retry.attempts}/${record.retry.maxAttempts})',
                  style: Theme.of(context)
                      .textTheme
                      .labelSmall
                      ?.copyWith(color: scheme.onSurfaceVariant),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _ResultRow extends StatelessWidget {
  const _ResultRow({required this.label, required this.icon, required this.result});

  final String label;
  final IconData icon;
  final PlatformPublishResult result;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (color, chipLabel) = switch (result.status) {
      'published' => (Colors.green, 'Published'),
      'failed' => (Colors.red, 'Failed'),
      _ => (Colors.grey, 'Not attempted'),
    };

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 16, color: scheme.primary),
        const SizedBox(width: 8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
              if (result.url != null)
                SelectableText(
                  result.url!,
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

String _formatTimestamp(String iso) {
  final parsed = DateTime.tryParse(iso);
  if (parsed == null) return iso;
  final local = parsed.toLocal();
  String two(int v) => v.toString().padLeft(2, '0');
  return '${two(local.day)}/${two(local.month)} ${two(local.hour)}:${two(local.minute)}';
}
