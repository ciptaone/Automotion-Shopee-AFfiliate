import 'package:flutter/material.dart';

import '../core/autopilot_api.dart';
import '../core/backend_client.dart';
import '../models/automation_models.dart';
import '../widgets/common.dart';

/// Integrations: backend connectivity plus the state of every external service
/// (Facebook, Threads, Telegram, AI, storage, feed import, PostgreSQL).
///
/// SECURITY: this screen renders configuration and verification state only.
/// It never receives, renders or logs an access token or any other secret —
/// the backend's `/v1/meta/integrations` contract contains none.
class IntegrationsScreen extends StatefulWidget {
  const IntegrationsScreen({super.key, required this.api, this.onSignedOut});

  final AutopilotApi api;
  final VoidCallback? onSignedOut;

  @override
  State<IntegrationsScreen> createState() => _IntegrationsScreenState();
}

class _IntegrationsScreenState extends State<IntegrationsScreen> {
  bool _loading = true;
  String? _error;
  bool _online = false;
  int? _latencyMs;
  DateTime? _lastSync;
  List<IntegrationHealthEntry> _entries = const [];

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = _entries.isEmpty;
      _error = null;
    });

    final stopwatch = Stopwatch()..start();
    final online = await widget.api.ping();
    stopwatch.stop();

    if (!online) {
      if (!mounted) return;
      setState(() {
        _online = false;
        _loading = false;
        _error = 'Backend is not reachable at ${widget.api.baseUrl}.';
      });
      return;
    }

    try {
      final entries = await widget.api.fetchIntegrations();
      if (!mounted) return;
      setState(() {
        _entries = entries;
        _online = true;
        _latencyMs = stopwatch.elapsedMilliseconds;
        _lastSync = DateTime.now();
        _loading = false;
      });
    } on AuthException {
      widget.onSignedOut?.call();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _online = true;
        _loading = false;
        _error = e.message;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Integrations'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: _loading ? null : _refresh,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const LoadingState(label: 'Checking integrations…');
    }
    if (!_online && _entries.isEmpty && _error != null) {
      return ErrorStateView(message: _error!, onRetry: _refresh);
    }

    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        children: [
          _connectivityCard(),
          if (_error != null) InlineErrorBanner(message: _error!, onRetry: _refresh),
          _integrationsCard(),
          _legendCard(),
          const SizedBox(height: 24),
        ],
      ),
    );
  }

  Widget _connectivityCard() {
    return SectionCard(
      title: 'Backend connectivity',
      icon: Icons.dns_outlined,
      trailing: StatusChip(
        label: _online ? 'Online' : 'Offline',
        color: _online ? Colors.green : Colors.red,
        icon: _online ? Icons.check_circle_rounded : Icons.cloud_off_rounded,
      ),
      children: [
        KeyValueRow('URL', widget.api.baseUrl),
        KeyValueRow('Latency', _latencyMs == null ? '—' : '${_latencyMs}ms'),
        KeyValueRow(
          'Last sync',
          _lastSync == null ? 'never' : _lastSync!.toLocal().toString().substring(0, 19),
        ),
        const SizedBox(height: 4),
        Text(
          'HTTPS is required in production. This app never sends provider '
          'credentials — every privileged call happens on the backend.',
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
      ],
    );
  }

  Widget _integrationsCard() {
    final scheme = Theme.of(context).colorScheme;
    return SectionCard(
      title: 'External services',
      icon: Icons.hub_rounded,
      trailing: StatusChip(
        label: '${_entries.length} services',
        color: scheme.primary,
      ),
      children: [
        if (_entries.isEmpty)
          EmptyStateView(
            icon: Icons.device_unknown_rounded,
            title: 'No integration data',
            message: 'The backend did not return any integration entries.',
          ),
        for (final entry in _entries) ...[
          _IntegrationTile(entry: entry),
          if (entry != _entries.last) const Divider(height: 12),
        ],
      ],
    );
  }

  Widget _legendCard() {
    return SectionCard(
      title: 'What the states mean',
      icon: Icons.help_outline_rounded,
      children: [
        for (final (label, description, color) in _legend)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 3),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                StatusDot(color: color),
                const SizedBox(width: 8),
                Expanded(
                  // Kept as one sentence so exact-match finds still address the
                  // per-service chips only, never the legend.
                  child: Text(
                    '$label — $description',
                    style: const TextStyle(fontSize: 12.5),
                  ),
                ),
              ],
            ),
          ),
        const SizedBox(height: 8),
        Text(
          'No access tokens, keys or secrets are displayed anywhere in this app.',
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: _outline(context), fontStyle: FontStyle.italic),
        ),
      ],
    );
  }

  static Color _outline(BuildContext context) => Theme.of(context).colorScheme.outline;

  static const List<(String, String, Color)> _legend = [
    ('Connected', 'Live credentials present and a live call verified.', Colors.green),
    ('Blocked', 'A required external prerequisite is missing.', Colors.red),
    ('Not tested', 'Configured or mocked, but no live call verified yet.', Colors.orange),
    ('Disconnected', 'Nothing is configured for this service.', Colors.grey),
  ];
}

class _IntegrationTile extends StatelessWidget {
  const _IntegrationTile({required this.entry});

  final IntegrationHealthEntry entry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (color, icon) = switch (entry.health) {
      IntegrationHealth.connected => (Colors.green, Icons.check_circle_rounded),
      IntegrationHealth.blocked => (Colors.red, Icons.block_rounded),
      IntegrationHealth.notTested => (Colors.orange, Icons.help_outline_rounded),
      IntegrationHealth.disconnected => (Colors.grey, Icons.circle_outlined),
    };

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 18, color: color),
        const SizedBox(width: 8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      entry.displayName,
                      style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5),
                    ),
                  ),
                  StatusChip(label: entry.health.label, color: color),
                ],
              ),
              const SizedBox(height: 2),
              Text(
                entry.healthDetail,
                style: Theme.of(context)
                    .textTheme
                    .bodySmall
                    ?.copyWith(color: scheme.onSurfaceVariant),
              ),
              if (entry.detail.isNotEmpty)
                Text(
                  entry.detail,
                  style: Theme.of(context)
                      .textTheme
                      .bodySmall
                      ?.copyWith(color: scheme.outline, fontSize: 11.5),
                ),
            ],
          ),
        ),
      ],
    );
  }
}
