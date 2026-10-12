import 'package:flutter/material.dart';

import '../core/app_config.dart';
import '../core/backend_client.dart';
import '../core/secure_store.dart';
import '../models/api_models.dart';
import 'login_screen.dart';

/// Main control surface: backend health, scheduler status, integration health,
/// and recent job activity. Everything shown here is READ-ONLY in Part 1 —
/// start/pause/resume controls are wired in the automation part.
class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  late final BackendClient _client;

  bool _loading = true;
  String? _error;
  HealthReport? _health;
  List<JobRecord> _jobs = const [];

  @override
  void initState() {
    super.initState();
    _client = BackendClient(baseUrl: AppConfig.backendUrl);
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final healthJson = await _client.getPublic('/health');
      final health = HealthReport.fromJson(healthJson);

      List<JobRecord> jobs = const [];
      try {
        final jobsJson = await _client.getAuthed('/v1/queue/jobs?limit=20');
        final raw = jobsJson['jobs'];
        if (raw is List) {
          jobs = raw
              .whereType<Map<String, dynamic>>()
              .map(JobRecord.fromJson)
              .toList();
        }
      } catch (_) {
        // Job list is non-fatal; the dashboard still renders health.
      }

      if (!mounted) return;
      setState(() {
        _health = health;
        _jobs = jobs;
        _loading = false;
      });
    } on AuthException {
      await _signOut();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _signOut() async {
    await SecureStore.instance.clearSession();
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(
        builder: (_) => LoginScreen(
          backendUrl: AppConfig.backendUrl,
          onLoggedIn: () {},
        ),
      ),
      (_) => false,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Autopilot Dashboard'),
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
    if (_loading && _health == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null && _health == null) {
      return _ErrorState(message: _error!, onRetry: _refresh);
    }

    final health = _health;
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (health != null) ...[
            _HealthCard(health: health),
            const SizedBox(height: 12),
            _SchedulerCard(scheduler: health.scheduler),
            const SizedBox(height: 12),
            _IntegrationsCard(integrations: health.integrations),
          ],
          if (_error != null) ...[
            const SizedBox(height: 4),
            _ErrorState(message: _error!, onRetry: _refresh, compact: true),
          ],
          const SizedBox(height: 12),
          _JobsCard(jobs: _jobs),
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Cards                                                                     */
/* -------------------------------------------------------------------------- */

class _HealthCard extends StatelessWidget {
  const _HealthCard({required this.health});
  final HealthReport health;

  @override
  Widget build(BuildContext context) {
    final ok = health.status == 'ok';
    final scheme = Theme.of(context).colorScheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  ok ? Icons.check_circle_rounded : Icons.warning_rounded,
                  color: ok ? Colors.green : Colors.orange,
                ),
                const SizedBox(width: 8),
                Text('Backend ${health.status}',
                    style: Theme.of(context).textTheme.titleMedium),
                const Spacer(),
                Text('v${health.version} · part ${health.part}',
                    style: Theme.of(context).textTheme.labelSmall),
              ],
            ),
            const SizedBox(height: 12),
            _KeyValue('Uptime', '${health.uptimeSeconds}s'),
            _KeyValue('Database', health.database.detail),
            if (health.degradedReasons.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text('Notes',
                  style: Theme.of(context)
                      .textTheme
                      .labelMedium
                      ?.copyWith(color: scheme.onSurfaceVariant)),
              const SizedBox(height: 4),
              for (final note in health.degradedReasons)
                Padding(
                  padding: const EdgeInsets.only(bottom: 2),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('• ', style: TextStyle(color: scheme.primary)),
                      Expanded(child: Text(note, style: const TextStyle(fontSize: 13))),
                    ],
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

class _SchedulerCard extends StatelessWidget {
  const _SchedulerCard({required this.scheduler});
  final SchedulerStatus scheduler;

  @override
  Widget build(BuildContext context) {
    final next = scheduler.nextSlot;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.schedule_rounded,
                    color: Theme.of(context).colorScheme.primary),
                const SizedBox(width: 8),
                Text('Scheduler', style: Theme.of(context).textTheme.titleMedium),
                const Spacer(),
                Chip(
                  label: Text(scheduler.enabled ? 'Enabled' : 'Paused'),
                  visualDensity: VisualDensity.compact,
                  backgroundColor: scheduler.enabled
                      ? Colors.green.shade50
                      : Colors.grey.shade200,
                ),
              ],
            ),
            const SizedBox(height: 12),
            _KeyValue('Time zone', scheduler.timezone),
            _KeyValue('Interval', 'every ${scheduler.intervalMinutes} minutes'),
            _KeyValue('Max slots / day', '${scheduler.maxSlotsPerDay}'),
            _KeyValue('Slots today', '${scheduler.slotsToday} (${scheduler.today})'),
            if (next != null)
              _KeyValue('Next slot', '${next.key}  ·  ${next.scheduledFor}'),
            const SizedBox(height: 4),
            Text(scheduler.message,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    )),
          ],
        ),
      ),
    );
  }
}

class _IntegrationsCard extends StatelessWidget {
  const _IntegrationsCard({required this.integrations});
  final List<IntegrationStatus> integrations;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.hub_rounded,
                    color: Theme.of(context).colorScheme.primary),
                const SizedBox(width: 8),
                Text('Integrations', style: Theme.of(context).textTheme.titleMedium),
              ],
            ),
            const SizedBox(height: 8),
            for (final item in integrations)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      item.configured
                          ? Icons.check_circle_rounded
                          : Icons.circle_outlined,
                      size: 18,
                      color: item.configured ? Colors.green : Colors.grey,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(item.service,
                              style: const TextStyle(
                                  fontWeight: FontWeight.w600, fontSize: 13)),
                          Text(item.detail,
                              style: TextStyle(
                                  fontSize: 12,
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onSurfaceVariant)),
                        ],
                      ),
                    ),
                    Text(item.mode,
                        style: Theme.of(context).textTheme.labelSmall),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _JobsCard extends StatelessWidget {
  const _JobsCard({required this.jobs});
  final List<JobRecord> jobs;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.workspaces_rounded,
                    color: Theme.of(context).colorScheme.primary),
                const SizedBox(width: 8),
                Text('Recent jobs', style: Theme.of(context).textTheme.titleMedium),
              ],
            ),
            const SizedBox(height: 8),
            if (jobs.isEmpty)
              Text('No jobs yet. The scheduler enqueues a job per slot.',
                  style: Theme.of(context).textTheme.bodySmall),
            for (final job in jobs)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(
                  children: [
                    _StatusDot(status: job.status),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(job.uniqueKey,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 13)),
                    ),
                    Text('${job.attempts}/${job.maxAttempts}',
                        style: Theme.of(context).textTheme.labelSmall),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _StatusDot extends StatelessWidget {
  const _StatusDot({required this.status});
  final String status;

  @override
  Widget build(BuildContext context) {
    final color = switch (status) {
      'succeeded' => Colors.green,
      'failed' => Colors.red,
      'running' => Colors.blue,
      'cancelled' => Colors.grey,
      _ => Colors.orange,
    };
    return Container(
      width: 10,
      height: 10,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Shared bits                                                              */
/* -------------------------------------------------------------------------- */

class _KeyValue extends StatelessWidget {
  const _KeyValue(this.label, this.value);
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 120,
            child: Text(label,
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    )),
          ),
          Expanded(child: Text(value, style: const TextStyle(fontSize: 13))),
        ],
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({
    required this.message,
    required this.onRetry,
    this.compact = false,
  });

  final String message;
  final VoidCallback onRetry;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    if (compact) {
      return Card(
        color: Theme.of(context).colorScheme.errorContainer,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              Icon(Icons.error_outline_rounded,
                  color: Theme.of(context).colorScheme.onErrorContainer),
              const SizedBox(width: 8),
              Expanded(
                child: Text(message,
                    style: TextStyle(
                        color: Theme.of(context).colorScheme.onErrorContainer,
                        fontSize: 13)),
              ),
              TextButton(onPressed: onRetry, child: const Text('Retry')),
            ],
          ),
        ),
      );
    }
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.cloud_off_rounded,
                size: 56, color: Theme.of(context).colorScheme.outline),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            FilledButton(onPressed: onRetry, child: const Text('Retry')),
          ],
        ),
      ),
    );
  }
}
