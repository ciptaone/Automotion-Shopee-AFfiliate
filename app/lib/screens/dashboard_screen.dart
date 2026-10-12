import 'package:flutter/material.dart';

import '../core/autopilot_api.dart';
import '../core/backend_client.dart';
import '../models/api_models.dart';
import '../models/automation_models.dart';
import '../widgets/common.dart';

/// What the operator sees at the top of the dashboard.
enum AutomationDisplayStatus { offline, degraded, running, paused }

/// Pure mapping from backend state to the displayed status. Kept separate from
/// the widget tree so tests can assert it without rendering.
AutomationDisplayStatus resolveDisplayStatus({
  required bool hasData,
  required bool offline,
  required AutomationStatus? status,
}) {
  if (!hasData || status == null) {
    return AutomationDisplayStatus.offline;
  }
  if (offline) {
    // Data may be stale, but the backend state itself is unknown right now.
    return AutomationDisplayStatus.offline;
  }
  if (status.degraded) {
    return AutomationDisplayStatus.degraded;
  }
  return status.state == AutomationState.running
      ? AutomationDisplayStatus.running
      : AutomationDisplayStatus.paused;
}

/// Dashboard: automation status, today's slot capacity, publication outcomes,
/// latest generated content (honestly empty until the pipeline exists) and the
/// backend connection state.
class DashboardScreen extends StatefulWidget {
  const DashboardScreen({
    super.key,
    required this.api,
    this.onSignOut,
  });

  final AutopilotApi api;
  final VoidCallback? onSignOut;

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  bool _loading = true;
  bool _offline = false;
  String? _error;
  bool _hasData = false;

  AutomationStatus? _status;
  DateTime? _lastSync;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = !_hasData;
      _error = null;
    });
    try {
      final status = await widget.api.fetchAutomationStatus();
      if (!mounted) return;
      setState(() {
        _status = status;
        _hasData = true;
        _loading = false;
        _offline = false;
        _error = null;
        _lastSync = DateTime.now();
      });
    } on AuthException {
      widget.onSignOut?.call();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _offline = e is NetworkException;
        _error = e.message;
      });
    }
  }

  void _signOut() {
    widget.api.signOut();
    widget.onSignOut?.call();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Dashboard'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: _loading ? null : _refresh,
            icon: const Icon(Icons.refresh_rounded),
          ),
          IconButton(
            tooltip: 'Sign out',
            onPressed: _signOut,
            icon: const Icon(Icons.logout_rounded),
          ),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading && !_hasData) {
      return const LoadingState(label: 'Loading dashboard…');
    }
    if (!_hasData && _error != null) {
      return ErrorStateView(message: _error!, onRetry: _refresh);
    }

    final status = _status;
    final display = resolveDisplayStatus(
      hasData: _hasData,
      offline: _offline,
      status: status,
    );

    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        children: [
          const AlwaysOnBanner(),
          if (_offline || _error != null)
            InlineErrorBanner(
              message: _offline
                  ? 'Backend offline — showing the last known state.'
                  : _error!,
              onRetry: _refresh,
            ),
          _StatusCard(
            display: display,
            status: status,
            lastSync: _lastSync,
            backendUrl: widget.api.baseUrl,
          ),
          if (status != null) ...[
            _SlotsCard(status: status),
            _PublicationsCard(counts: status.publications),
            _LatestContentCard(note: status.latestContentNote),
            _ActivityCard(activity: status.recentActivity),
          ],
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Cards                                                                     */
/* -------------------------------------------------------------------------- */

class _StatusCard extends StatelessWidget {
  const _StatusCard({
    required this.display,
    required this.status,
    required this.lastSync,
    required this.backendUrl,
  });

  final AutomationDisplayStatus display;
  final AutomationStatus? status;
  final DateTime? lastSync;
  final String backendUrl;

  ({String label, Color color, IconData icon, String explanation}) get _visual {
    final schemeColor = Colors.grey;
    switch (display) {
      case AutomationDisplayStatus.running:
        return (
          label: 'Running',
          color: Colors.green,
          icon: Icons.play_circle_rounded,
          explanation:
              'The backend is scheduling content automatically. Publishing stays disabled until live integrations are authorized.',
        );
      case AutomationDisplayStatus.paused:
        return (
          label: 'Paused',
          color: Colors.orange,
          icon: Icons.pause_circle_rounded,
          explanation: 'Automation is paused. The backend stays online and ready.',
        );
      case AutomationDisplayStatus.degraded:
        return (
          label: 'Degraded',
          color: Colors.redAccent,
          icon: Icons.warning_amber_rounded,
          explanation: 'Automation is on, but something needed for publishing is missing.',
        );
      case AutomationDisplayStatus.offline:
        return (
          label: 'Offline',
          color: schemeColor,
          icon: Icons.cloud_off_rounded,
          explanation: 'The backend could not be reached from this device.',
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final visual = _visual;
    final syncText = lastSync == null
        ? 'never'
        : '${_formatClock(lastSync!)}  ·  ${_relative(lastSync!)}';
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(visual.icon, size: 32, color: visual.color),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        visual.label,
                        style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                              fontWeight: FontWeight.w700,
                              color: visual.color,
                            ),
                      ),
                      Text(
                        'Automation status',
                        style: Theme.of(context).textTheme.labelMedium,
                      ),
                    ],
                  ),
                ),
                StatusChip(
                  label: status?.timezone ?? 'Asia/Jakarta',
                  color: Theme.of(context).colorScheme.primary,
                  icon: Icons.schedule_rounded,
                ),
              ],
            ),
            const SizedBox(height: 12),
            Text(
              visual.explanation,
              style: Theme.of(context)
                  .textTheme
                  .bodySmall
                  ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
            ),
            if (status != null && status!.degradedReasons.isNotEmpty) ...[
              const SizedBox(height: 8),
              for (final reason in status!.degradedReasons)
                Padding(
                  padding: const EdgeInsets.only(bottom: 2),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('• ', style: TextStyle(color: visual.color)),
                      Expanded(
                        child: Text(reason, style: const TextStyle(fontSize: 12.5)),
                      ),
                    ],
                  ),
                ),
            ],
            const Divider(height: 20),
            KeyValueRow('Backend', backendUrl),
            KeyValueRow('Last sync', syncText),
            if (status != null) KeyValueRow('Server time', status!.serverTime),
          ],
        ),
      ),
    );
  }
}

class _SlotsCard extends StatelessWidget {
  const _SlotsCard({required this.status});
  final AutomationStatus status;

  @override
  Widget build(BuildContext context) {
    final pct = status.slotFill;
    return SectionCard(
      title: "Today's slots",
      icon: Icons.calendar_view_day_rounded,
      trailing: StatusChip(
        label: '${status.slotsRemaining} left',
        color: status.slotsRemaining == 0 ? Colors.red : Colors.green,
      ),
      children: [
        KeyValueRow('Date', '${status.today} (${status.timezone})'),
        KeyValueRow('Capacity', '${status.slotsScheduled} slots scheduled'),
        KeyValueRow('Used', '${status.slotsUsed} slots'),
        KeyValueRow('Remaining', '${status.slotsRemaining} slots'),
        const SizedBox(height: 8),
        ClipRRect(
          borderRadius: BorderRadius.circular(999),
          child: LinearProgressIndicator(
            value: pct.clamp(0.0, 1.0),
            minHeight: 8,
            backgroundColor: Theme.of(context).colorScheme.surfaceContainerHighest,
          ),
        ),
      ],
    );
  }
}

class _PublicationsCard extends StatelessWidget {
  const _PublicationsCard({required this.counts});
  final PublicationCounts counts;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      title: 'Publications',
      icon: Icons.publish_rounded,
      trailing: StatusChip(
        label: 'source: ${counts.source}',
        color: Theme.of(context).colorScheme.primary,
        tooltip: 'Counters come from the live job queue, not from fixtures.',
      ),
      children: [
        Row(
          children: [
            _Counter(
              label: 'Succeeded',
              value: counts.succeeded,
              color: Colors.green,
              icon: Icons.check_circle_rounded,
            ),
            _Counter(
              label: 'Failed',
              value: counts.failed,
              color: Colors.red,
              icon: Icons.cancel_rounded,
            ),
            _Counter(
              label: 'Retrying',
              value: counts.retrying,
              color: Colors.orange,
              icon: Icons.autorenew_rounded,
            ),
          ],
        ),
        const SizedBox(height: 4),
        Text(
          'Counters cover today only and update as the backend processes jobs.',
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
      ],
    );
  }
}

class _Counter extends StatelessWidget {
  const _Counter({
    required this.label,
    required this.value,
    required this.color,
    required this.icon,
  });

  final String label;
  final int value;
  final Color color;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Column(
        children: [
          Icon(icon, color: color, size: 22),
          const SizedBox(height: 4),
          Text(
            '$value',
            style: Theme.of(context).textTheme.titleLarge?.copyWith(
                  fontWeight: FontWeight.w700,
                  color: color,
                ),
          ),
          Text(label, style: Theme.of(context).textTheme.labelSmall),
        ],
      ),
    );
  }
}

class _LatestContentCard extends StatelessWidget {
  const _LatestContentCard({required this.note});
  final String note;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      title: 'Latest generated content',
      icon: Icons.auto_awesome_outlined,
      children: [
        EmptyStateView(
          icon: Icons.image_not_supported_outlined,
          title: 'Nothing generated yet',
          message: note.isEmpty
              ? 'The generation pipeline is not implemented yet.'
              : note,
        ),
        const SizedBox(height: 4),
        Text(
          'Open the Preview tab to inspect fixture content the client is built against.',
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
      ],
    );
  }
}

class _ActivityCard extends StatelessWidget {
  const _ActivityCard({required this.activity});
  final List<JobRecord> activity;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SectionCard(
      title: 'Recent activity',
      icon: Icons.workspaces_rounded,
      trailing: StatusChip(
        label: 'job queue',
        color: scheme.primary,
      ),
      children: [
        if (activity.isEmpty)
          EmptyStateView(
            icon: Icons.inbox_outlined,
            title: 'No activity yet',
            message: 'Jobs appear here as soon as the scheduler enqueues a slot.',
          ),
        for (final job in activity)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Row(
              children: [
                StatusDot(color: _colorFor(job.status)),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    job.uniqueKey.isEmpty ? job.kind : job.uniqueKey,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 13),
                  ),
                ),
                Text(
                  job.status,
                  style: TextStyle(fontSize: 12, color: _colorFor(job.status)),
                ),
                const SizedBox(width: 8),
                Text(
                  '${job.attempts}/${job.maxAttempts}',
                  style: Theme.of(context).textTheme.labelSmall,
                ),
              ],
            ),
          ),
      ],
    );
  }

  Color _colorFor(String status) => switch (status) {
        'succeeded' => Colors.green,
        'failed' => Colors.red,
        'running' => Colors.blue,
        'cancelled' => Colors.grey,
        _ => Colors.orange,
      };
}

/* -------------------------------------------------------------------------- */
/*  Formatting helpers                                                        */
/* -------------------------------------------------------------------------- */

String _formatClock(DateTime time) {
  final local = time.toLocal();
  String two(int v) => v.toString().padLeft(2, '0');
  return '${two(local.hour)}:${two(local.minute)}';
}

String _relative(DateTime time) {
  final delta = DateTime.now().difference(time);
  if (delta.inSeconds < 60) return '${delta.inSeconds}s ago';
  if (delta.inMinutes < 60) return '${delta.inMinutes}m ago';
  return '${delta.inHours}h ago';
}
