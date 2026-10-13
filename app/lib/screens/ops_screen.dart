import 'dart:async';

import 'package:flutter/material.dart';

import '../core/autopilot_api.dart';
import '../core/backend_client.dart';
import '../models/ops_models.dart';
import '../widgets/common.dart';

/// PART 8 §5 — Ops dashboard: the operator's single view of backend health.
///
/// Reads GET /v1/ops/health only (authenticated, read scope). The backend
/// answers from cached probes and configuration, so opening this tab never
/// calls a paid AI API and needs no AI credential. Publishing is reported as
/// disabled-by-design and this screen cannot change any state.
class OpsScreen extends StatefulWidget {
  const OpsScreen({super.key, required this.api, this.onSignOut});

  final AutopilotApi api;
  final VoidCallback? onSignOut;

  @override
  State<OpsScreen> createState() => _OpsScreenState();
}

/// How often the tab re-syncs while visible (bounded, §5 "reasonable refresh").
const Duration kOpsAutoRefreshInterval = Duration(seconds: 60);

/// Data older than this is flagged as stale so the operator never trusts a
/// frozen screen.
const Duration kOpsStaleAfter = Duration(minutes: 2);

/* -------------------------------------------------------------------------- */
/*  Pure display helpers (unit-tested without rendering)                       */
/* -------------------------------------------------------------------------- */

/// Locked status → colour mapping for the seven-status vocabulary.
Color opsStatusColor(String status) => switch (status) {
      'healthy' => const Color(0xFF2E7D32),
      'degraded' => const Color(0xFFB26A00),
      'blocked' => const Color(0xFFC62828),
      'unavailable' => const Color(0xFFC62828),
      'not_configured' => const Color(0xFF616161),
      'not_tested' => const Color(0xFF546E7A),
      'disabled' => const Color(0xFF757575),
      _ => const Color(0xFF546E7A),
    };

/// Locked status → leading icon.
IconData opsStatusIcon(String status) => switch (status) {
      'healthy' => Icons.check_circle_outline_rounded,
      'degraded' => Icons.warning_amber_outlined,
      'blocked' => Icons.block_rounded,
      'unavailable' => Icons.cloud_off_rounded,
      'not_configured' => Icons.settings_suggest_outlined,
      'not_tested' => Icons.help_outline_rounded,
      'disabled' => Icons.pause_circle_outline_rounded,
      _ => Icons.help_outline_rounded,
    };

/// Human label with underscores removed ("not_configured" → "Not configured").
String opsStatusLabel(String status) {
  if (status.isEmpty) return 'Unknown';
  final joined = status.split('_').join(' ');
  return '${joined[0].toUpperCase()}${joined.substring(1)}';
}

/// True when [lastSync] is older than [staleAfter] (checked at call time).
bool opsDataIsStale(DateTime? lastSync, {DateTime? now, Duration staleAfter = kOpsStaleAfter}) {
  if (lastSync == null) return true;
  return (now ?? DateTime.now()).difference(lastSync) > staleAfter;
}

/// Compact human duration for queue ages ("5m", "2h", "30s").
String opsFormatAge(int? milliseconds) {
  if (milliseconds == null || milliseconds < 0) return '—';
  final seconds = milliseconds ~/ 1000;
  if (seconds < 60) return '${seconds}s';
  final minutes = seconds ~/ 60;
  if (minutes < 60) return '${minutes}m';
  final hours = minutes ~/ 60;
  if (hours < 48) return '${hours}h';
  return '${hours ~/ 24}d';
}

/* -------------------------------------------------------------------------- */

class _OpsScreenState extends State<OpsScreen> {
  OpsHealthReport? _report;
  bool _loading = true;
  bool _offline = false;
  String? _error;
  DateTime? _lastSync;
  Timer? _autoRefresh;

  @override
  void initState() {
    super.initState();
    _refresh();
    _autoRefresh = Timer.periodic(kOpsAutoRefreshInterval, (_) {
      if (!mounted || _loading) return;
      _refresh(silent: true);
    });
  }

  @override
  void dispose() {
    _autoRefresh?.cancel();
    super.dispose();
  }

  Future<void> _refresh({bool silent = false}) async {
    setState(() {
      _loading = !silent || _report == null;
      if (!silent) _error = null;
    });
    try {
      final report = await widget.api.fetchOpsHealth();
      if (!mounted) return;
      setState(() {
        _report = report;
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
        title: const Text('Ops'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: _loading ? null : () => _refresh(),
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
    final report = _report;
    if (report == null) {
      if (_loading) return const LoadingState(label: 'Loading operations…');
      return ErrorStateView(
        message: _offline
            ? 'Backend unreachable. Operations data could not be loaded.'
            : (_error ?? 'Operations data could not be loaded.'),
        onRetry: () => _refresh(),
      );
    }
    return RefreshIndicator(
      onRefresh: () => _refresh(),
      child: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          if (_error != null)
            InlineErrorBanner(
              message: 'Refresh failed — showing the last known state. $_error',
              onRetry: () => _refresh(),
            ),
          _OverallCard(report: report, lastSync: _lastSync, offline: _offline),
          _EnvironmentCard(report: report),
          _SchedulerCard(report: report),
          _QueueCard(report: report),
          _ComponentsCard(report: report),
          _PublishingGateCard(report: report),
          _RecentEventsCard(events: report.recentEvents),
        ],
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Cards                                                                      */
/* -------------------------------------------------------------------------- */

class _OverallCard extends StatelessWidget {
  const _OverallCard({required this.report, required this.lastSync, required this.offline});

  final OpsHealthReport report;
  final DateTime? lastSync;
  final bool offline;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final color = opsStatusColor(report.overall);
    final stale = offline || opsDataIsStale(lastSync);
    final theme = Theme.of(context);
    return SectionCard(
      title: 'Overall status',
      icon: Icons.monitor_heart_outlined,
      trailing: StatusChip(
        label: opsStatusLabel(report.overall),
        color: color,
        icon: opsStatusIcon(report.overall),
      ),
      children: [
        Row(
          children: [
            Icon(opsStatusIcon(report.overall), color: color, size: 28),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    report.ready
                        ? 'Ready to accept generation work'
                        : 'NOT ready — generation work must not be sent',
                    style: theme.textTheme.titleSmall?.copyWith(
                      color: report.ready ? scheme.onSurface : scheme.error,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    'Persistence: ${report.persistenceBackend} · uptime ${opsFormatAge(report.uptimeSeconds * 1000)}',
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: scheme.onSurfaceVariant),
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 4,
          children: [
            StatusChip(
              label: stale ? 'Data stale' : 'Up to date',
              color: stale ? const Color(0xFFB26A00) : const Color(0xFF2E7D32),
              icon: stale ? Icons.history_toggle_off_rounded : Icons.sync_rounded,
            ),
            if (offline)
              const StatusChip(
                label: 'Backend offline',
                color: Color(0xFFC62828),
                icon: Icons.cloud_off_rounded,
              ),
            if (report.blockers.isNotEmpty)
              StatusChip(
                label: '${report.blockers.length} blocker(s)',
                color: const Color(0xFFC62828),
                icon: Icons.block_rounded,
              ),
          ],
        ),
        if (report.blockers.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text(
            report.blockers.join(', '),
            style: theme.textTheme.bodySmall?.copyWith(color: scheme.error),
          ),
        ],
        const SizedBox(height: 6),
        Text(
          lastSync == null
              ? 'Not synced yet'
              : 'Last update: ${_formatClock(lastSync!)} · server check ${_formatClock(DateTime.tryParse(report.checkedAt))}',
          style: theme.textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
        ),
      ],
    );
  }
}

class _EnvironmentCard extends StatelessWidget {
  const _EnvironmentCard({required this.report});

  final OpsHealthReport report;

  @override
  Widget build(BuildContext context) {
    final storage = report.components.where((c) => c.key == 'asset_storage').toList();
    final storageKind =
        storage.isEmpty ? 'unknown' : (storage.first.data['kind']?.toString() ?? 'unknown');
    final isMock = report.scheduler.mode == 'mock' || storageKind == 'mock';
    return SectionCard(
      title: 'Environment',
      icon: Icons.dns_outlined,
      children: [
        KeyValueRow('Persistence', report.persistenceBackend),
        KeyValueRow('Scheduler mode', report.scheduler.mode),
        KeyValueRow('Asset storage', storageKind),
        if (isMock) ...[
          const SizedBox(height: 8),
          const FixtureBanner(
            message:
                'Development configuration: mock scheduler/storage in use. Content and assets here are NOT real production output.',
          ),
        ],
      ],
    );
  }
}

class _SchedulerCard extends StatelessWidget {
  const _SchedulerCard({required this.report});

  final OpsHealthReport report;

  @override
  Widget build(BuildContext context) {
    final scheduler = report.scheduler;
    final component = _find(report, 'scheduler');
    return SectionCard(
      title: 'Scheduler',
      icon: Icons.schedule_outlined,
      trailing: component == null
          ? null
          : StatusChip(
              label: opsStatusLabel(component.status),
              color: opsStatusColor(component.status),
              icon: opsStatusIcon(component.status),
            ),
      children: [
        KeyValueRow('Loop', scheduler.enabled ? 'Enabled (${scheduler.mode})' : 'Disabled'),
        KeyValueRow('Automation', opsStatusLabel(scheduler.automationState)),
        KeyValueRow('Timezone', scheduler.timezone),
        KeyValueRow('Daily target', '${scheduler.slotsToday}/${scheduler.dailyPostTarget} slots today (${scheduler.today})'),
        KeyValueRow('Next slot', scheduler.nextSlotAt ?? 'None scheduled'),
        KeyValueRow('Last tick', scheduler.lastTickAt ?? 'No tick yet'),
        if (scheduler.lastTickExecuted != null || scheduler.lastTickSkipped != null)
          KeyValueRow(
            'Last tick outcome',
            'executed ${scheduler.lastTickExecuted ?? 0} · skipped ${scheduler.lastTickSkipped ?? 0}',
          ),
        if (component != null && component.message.isNotEmpty) ...[
          const SizedBox(height: 6),
          Text(
            component.message,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: opsStatusColor(component.status),
                ),
          ),
        ],
      ],
    );
  }
}

class _QueueCard extends StatelessWidget {
  const _QueueCard({required this.report});

  final OpsHealthReport report;

  @override
  Widget build(BuildContext context) {
    final queue = report.queue;
    final component = _find(report, 'queue');
    return SectionCard(
      title: 'Queue',
      icon: Icons.queue_outlined,
      trailing: component == null
          ? null
          : StatusChip(
              label: opsStatusLabel(component.status),
              color: opsStatusColor(component.status),
              icon: opsStatusIcon(component.status),
            ),
      children: [
        if (queue == null)
          Text(
            component?.message ?? 'Queue statistics are not available.',
            style: Theme.of(context).textTheme.bodySmall,
          )
        else ...[
          Wrap(
            spacing: 8,
            runSpacing: 6,
            children: [
              _countChip(context, 'Pending', queue.pending, Colors.blueGrey),
              _countChip(context, 'Running', queue.running, Colors.indigo),
              _countChip(context, 'Retrying', queue.retrying, const Color(0xFFB26A00)),
              _countChip(context, 'Succeeded', queue.succeeded, const Color(0xFF2E7D32)),
              _countChip(context, 'Failed', queue.failed, const Color(0xFFC62828)),
              _countChip(context, 'Cancelled', queue.cancelled, Colors.grey),
            ],
          ),
          const SizedBox(height: 8),
          KeyValueRow('Oldest pending', opsFormatAge(queue.oldestPendingAgeMs)),
          KeyValueRow('Expired leases', '${queue.expiredLeases}'),
        ],
      ],
    );
  }

  Widget _countChip(BuildContext context, String label, int value, Color color) =>
      StatusChip(label: '$label $value', color: color);
}

class _ComponentsCard extends StatelessWidget {
  const _ComponentsCard({required this.report});

  final OpsHealthReport report;

  @override
  Widget build(BuildContext context) {
    // The publishing gate gets its own card; everything else is listed here.
    final components =
        report.components.where((c) => c.key != 'publishing_gate').toList();
    return SectionCard(
      title: 'Components',
      icon: Icons.widgets_outlined,
      children: [
        for (final component in components)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    StatusDot(color: opsStatusColor(component.status)),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        component.displayName,
                        style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5),
                      ),
                    ),
                    StatusChip(
                      label: opsStatusLabel(component.status),
                      color: opsStatusColor(component.status),
                      icon: opsStatusIcon(component.status),
                      tooltip: 'Code: ${component.code}',
                    ),
                  ],
                ),
                if (component.message.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(left: 18, top: 2),
                    child: Text(
                      component.message,
                      style: Theme.of(context)
                          .textTheme
                          .bodySmall
                          ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
                    ),
                  ),
              ],
            ),
          ),
      ],
    );
  }
}

class _PublishingGateCard extends StatelessWidget {
  const _PublishingGateCard({required this.report});

  final OpsHealthReport report;

  @override
  Widget build(BuildContext context) {
    final gate = report.publishingGate;
    final theme = Theme.of(context);
    return SectionCard(
      title: 'Publishing gate',
      icon: Icons.gavel_outlined,
      trailing: gate == null
          ? null
          : StatusChip(
              label: opsStatusLabel(gate.status),
              color: opsStatusColor(gate.status),
              icon: opsStatusIcon(gate.status),
            ),
      children: [
        Text(
          'Live publishing to Facebook and Threads is DISABLED by design in this build. '
          'Content generation ends at “publish_ready” and is reviewed in Preview.',
          style: theme.textTheme.bodySmall,
        ),
        const SizedBox(height: 6),
        KeyValueRow(
          'Gate state',
          gate == null ? 'Unknown' : '${opsStatusLabel(gate.status)} (${gate.code})',
        ),
        if (gate != null)
          KeyValueRow('Facebook / Threads',
              '${gate.data['facebook'] ?? 'disabled'} / ${gate.data['threads'] ?? 'disabled'}'),
      ],
    );
  }
}

class _RecentEventsCard extends StatelessWidget {
  const _RecentEventsCard({required this.events});

  final List<OpsEvent> events;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SectionCard(
      title: 'Recent operational events',
      icon: Icons.bolt_outlined,
      trailing: events.isEmpty
          ? null
          : StatusChip(label: '${events.length}', color: Colors.blueGrey),
      children: [
        if (events.isEmpty)
          const EmptyStateView(
            icon: Icons.check_circle_outline_rounded,
            title: 'No operational events',
            message:
                'Nothing has failed or degraded since the oldest retained event. Events are deduplicated with cooldowns, so a persistent problem appears once per window.',
          )
        else
          for (final event in events)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 5),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      StatusDot(color: opsStatusColor(event.severity == 'critical' ? 'blocked' : event.severity == 'warning' ? 'degraded' : 'not_tested')),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          event.title,
                          style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5),
                        ),
                      ),
                      StatusChip(
                        label: opsStatusLabel(event.severity),
                        color: opsStatusColor(
                            event.severity == 'critical' ? 'blocked' : event.severity == 'warning' ? 'degraded' : 'not_tested'),
                      ),
                    ],
                  ),
                  Padding(
                    padding: const EdgeInsets.only(left: 18, top: 2),
                    child: Text(
                      [
                        if (event.detail != null && event.detail!.isNotEmpty) event.detail!,
                        'kind ${event.kind} · ×${event.occurrences} · delivery ${event.lastDeliveryStatus}'
                            '${event.lastErrorCode == null ? '' : ' (${event.lastErrorCode})'}',
                      ].join('\n'),
                      style: themeBodySmall(context)?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                  ),
                ],
              ),
            ),
      ],
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Small utilities                                                            */
/* -------------------------------------------------------------------------- */

OpsComponent? _find(OpsHealthReport report, String key) {
  for (final component in report.components) {
    if (component.key == key) return component;
  }
  return null;
}

TextStyle? themeBodySmall(BuildContext context) => Theme.of(context).textTheme.bodySmall;

/// "14:05" clock formatting for ISO timestamps (local time, WIB on device).
String _formatClock(DateTime? moment) {
  if (moment == null) return '—';
  final local = moment.toLocal();
  final hh = local.hour.toString().padLeft(2, '0');
  final mm = local.minute.toString().padLeft(2, '0');
  return '$hh:$mm';
}
