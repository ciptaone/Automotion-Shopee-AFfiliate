import 'package:flutter/material.dart';

import '../core/autopilot_api.dart';
import '../core/backend_client.dart';
import '../models/automation_models.dart';
import '../models/image_count_policy.dart';
import '../widgets/common.dart';

/// Automation settings: schedule, destinations, image-count policy, Telegram
/// notifications and the start/pause/resume controls.
///
/// The backend is the source of truth: values are loaded from it on open and
/// written back through the supported `PUT /v1/settings` contract. Nothing
/// authoritative is cached in the APK.
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key, required this.api, this.onSignedOut});

  final AutopilotApi api;
  final VoidCallback? onSignedOut;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final _intervalController = TextEditingController();
  final _slotsController = TextEditingController();
  final _formKey = GlobalKey<FormState>();

  bool _loading = true;
  bool _saving = false;
  String? _error;
  List<String> _issues = const [];
  bool _dirty = false;

  SettingsPayload? _payload;
  bool _facebookEnabled = true;
  bool _threadsEnabled = true;
  bool _telegramEnabled = true;
  ImageCountPolicy _policy = ImageCountPolicy.defaultValue;
  AutomationState _state = AutomationState.paused;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _intervalController.dispose();
    _slotsController.dispose();
    super.dispose();
  }

  SettingsConstraints get _constraints =>
      _payload?.constraints ??
      const SettingsConstraints(
        minIntervalMinutes: 15,
        maxIntervalMinutes: 720,
        maxSlotsPerDay: 24,
        imageCountPolicies: ImageCountPolicy.wireValues,
      );

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final payload = await widget.api.fetchSettings();
      if (!mounted) return;
      setState(() {
        _payload = payload;
        _apply(payload.settings);
        _loading = false;
        _dirty = false;
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

  void _apply(AutomationSettings settings) {
    _intervalController.text = '${settings.intervalMinutes}';
    _slotsController.text = '${settings.maxSlotsPerDay}';
    _facebookEnabled = settings.facebookEnabled;
    _threadsEnabled = settings.threadsEnabled;
    _telegramEnabled = settings.telegramNotificationsEnabled;
    _policy = settings.imageCountPolicy;
    _state = settings.automationState;
  }

  void _markDirty() {
    if (!_dirty) setState(() => _dirty = true);
  }

  int get _interval => int.tryParse(_intervalController.text.trim()) ?? 0;
  int get _slots => int.tryParse(_slotsController.text.trim()) ?? 0;

  String? get _localScheduleIssue {
    if (_interval * _slots > 24 * 60) {
      return '$_slots slots every $_interval minutes exceed one 24-hour day. '
          'Lower the interval or the slot limit.';
    }
    return null;
  }

  Future<void> _save() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    final issue = _localScheduleIssue;
    if (issue != null) {
      setState(() {
        _issues = [issue];
        _error = null;
      });
      return;
    }

    setState(() {
      _saving = true;
      _issues = const [];
      _error = null;
    });

    final patch = <String, dynamic>{
      'intervalMinutes': _interval,
      'maxSlotsPerDay': _slots,
      'facebookEnabled': _facebookEnabled,
      'threadsEnabled': _threadsEnabled,
      'imageCountPolicy': _policy.wireValue,
      'telegramNotificationsEnabled': _telegramEnabled,
    };

    try {
      final payload = await widget.api.saveSettings(patch);
      if (!mounted) return;
      setState(() {
        _payload = payload;
        _apply(payload.settings);
        _saving = false;
        _dirty = false;
      });
      _snack('Settings saved on the backend.');
    } on AuthException {
      widget.onSignedOut?.call();
    } on ServerException catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _issues = e.issues;
        _error = e.issues.isEmpty ? e.message : null;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = e.message;
      });
    }
  }

  Future<void> _control(AutomationAction action) async {
    final confirmed = await _confirm(action);
    if (confirmed != true) return;

    setState(() => _saving = true);
    try {
      final result = await widget.api.controlAutomation(action.wireValue);
      if (!mounted) return;
      setState(() {
        _state = result.state;
        _payload = _payload == null
            ? null
            : SettingsPayload(
                settings: result.settings,
                storageKind: _payload!.storageKind,
                warning: _payload!.warning,
                constraints: _payload!.constraints,
                note: _payload!.note,
              );
        _saving = false;
      });
      _snack(result.note.isEmpty ? 'Automation ${result.state.label}' : result.note);
    } on AuthException {
      widget.onSignedOut?.call();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = e.message;
      });
    }
  }

  Future<bool?> _confirm(AutomationAction action) {
    final message = switch (action) {
      AutomationAction.start =>
        'Start automation? The backend will schedule one content slot per interval.',
      AutomationAction.resume =>
        'Resume automation? The backend will continue from the next free slot.',
      AutomationAction.pause =>
        'Pause automation? No content will be scheduled or published until you resume.',
    };
    return showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('${action.label} automation?'),
        content: Text(message),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(action.label),
          ),
        ],
      ),
    );
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Automation settings'),
        actions: [
          IconButton(
            tooltip: 'Reload',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading && _payload == null) {
      return const LoadingState(label: 'Loading settings…');
    }
    if (_payload == null && _error != null) {
      return ErrorStateView(message: _error!, onRetry: _load);
    }

    return Form(
      key: _formKey,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const AlwaysOnBanner(),
          if (_error != null) InlineErrorBanner(message: _error!),
          if (_issues.isNotEmpty)
            InlineErrorBanner(message: 'Settings rejected:\n${_issues.join('\n')}'),
          _controlCard(),
          _scheduleCard(),
          _destinationsCard(),
          _contentCard(),
          _notificationsCard(),
          _storageCard(),
          const SizedBox(height: 32),
        ],
      ),
    );
  }

  /* --- cards ------------------------------------------------------------ */

  Widget _controlCard() {
    final running = _state == AutomationState.running;
    return SectionCard(
      title: 'Automation control',
      icon: Icons.tune_rounded,
      trailing: StatusChip(
        label: _state.label,
        color: running ? Colors.green : Colors.orange,
        icon: running ? Icons.play_arrow_rounded : Icons.pause_rounded,
      ),
      children: [
        Text(
          running
              ? 'Automation is active. The backend keeps working even when this app is closed or your phone is offline.'
              : 'Automation is paused. The backend stays online but will not schedule or publish anything.',
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            FilledButton.icon(
              onPressed: _saving ? null : () => _control(AutomationAction.start),
              icon: const Icon(Icons.play_arrow_rounded),
              label: const Text('Start'),
            ),
            FilledButton.tonalIcon(
              onPressed: _saving ? null : () => _control(AutomationAction.pause),
              icon: const Icon(Icons.pause_rounded),
              label: const Text('Pause'),
            ),
            FilledButton.tonalIcon(
              onPressed: _saving ? null : () => _control(AutomationAction.resume),
              icon: const Icon(Icons.play_circle_outline_rounded),
              label: const Text('Resume'),
            ),
          ],
        ),
      ],
    );
  }

  Widget _scheduleCard() {
    final issue = _localScheduleIssue;
    final scheme = Theme.of(context).colorScheme;
    return SectionCard(
      title: 'Posting schedule',
      icon: Icons.schedule_rounded,
      children: [
        TextFormField(
          controller: _intervalController,
          keyboardType: TextInputType.number,
          decoration: InputDecoration(
            labelText: 'Posting interval (minutes)',
            helperText:
                'Default 60 minutes. Allowed: ${_constraints.minIntervalMinutes}-${_constraints.maxIntervalMinutes}.',
            border: const OutlineInputBorder(),
            prefixIcon: const Icon(Icons.timer_outlined),
          ),
          onChanged: (_) => _markDirty(),
          validator: (value) {
            final parsed = int.tryParse((value ?? '').trim());
            if (parsed == null) return 'Enter a whole number of minutes';
            if (parsed < _constraints.minIntervalMinutes ||
                parsed > _constraints.maxIntervalMinutes) {
              return 'Between ${_constraints.minIntervalMinutes} and ${_constraints.maxIntervalMinutes}';
            }
            return null;
          },
        ),
        const SizedBox(height: 12),
        TextFormField(
          controller: _slotsController,
          keyboardType: TextInputType.number,
          decoration: InputDecoration(
            labelText: 'Daily slot limit',
            helperText:
                'Maximum ${_constraints.maxSlotsPerDay} slots per Asia/Jakarta day (locked).',
            border: const OutlineInputBorder(),
            prefixIcon: const Icon(Icons.view_day_outlined),
          ),
          onChanged: (_) => _markDirty(),
          validator: (value) {
            final parsed = int.tryParse((value ?? '').trim());
            if (parsed == null) return 'Enter a whole number of slots';
            if (parsed < 1 || parsed > _constraints.maxSlotsPerDay) {
              return 'Between 1 and ${_constraints.maxSlotsPerDay}';
            }
            return null;
          },
        ),
        if (issue != null) ...[
          const SizedBox(height: 8),
          Text(issue, style: TextStyle(color: scheme.error, fontSize: 12.5)),
        ],
      ],
    );
  }

  Widget _destinationsCard() {
    return SectionCard(
      title: 'Publishing destinations',
      icon: Icons.share_rounded,
      children: [
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Facebook Page'),
          subtitle: const Text('Publish one post per slot to the connected Page.'),
          value: _facebookEnabled,
          onChanged: (value) {
            setState(() => _facebookEnabled = value);
            _markDirty();
          },
        ),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Threads'),
          subtitle: const Text('Same image set and caption, published independently.'),
          value: _threadsEnabled,
          onChanged: (value) {
            setState(() => _threadsEnabled = value);
            _markDirty();
          },
        ),
        if (!_facebookEnabled && !_threadsEnabled)
          Text(
            'Both destinations are off: slots would be skipped entirely.',
            style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12.5),
          ),
      ],
    );
  }

  Widget _contentCard() {
    return SectionCard(
      title: 'Content',
      icon: Icons.auto_awesome_outlined,
      children: [
        DropdownButtonFormField<ImageCountPolicy>(
          // Keyed by value so an external reload (settings fetched after the
          // first build) always shows the authoritative policy.
          key: ValueKey<String>('policy-${_policy.wireValue}'),
          initialValue: _policy,
          decoration: const InputDecoration(
            labelText: 'Image count per content slot',
            border: OutlineInputBorder(),
            prefixIcon: Icon(Icons.photo_library_outlined),
          ),
          items: [
            for (final policy in ImageCountPolicy.values)
              DropdownMenuItem(value: policy, child: Text(policy.label)),
          ],
          onChanged: (value) {
            if (value == null) return;
            setState(() => _policy = value);
            _markDirty();
          },
        ),
        const SizedBox(height: 8),
        Text(
          _policy.explanation,
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: 4),
        Text(
          'Actual image generation runs on the backend and is not implemented yet; '
          'the preview screen shows fixture content only.',
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: Theme.of(context).colorScheme.outline),
        ),
      ],
    );
  }

  Widget _notificationsCard() {
    final integrationState =
        _telegramEnabled ? 'Enabled in settings' : 'Disabled in settings';
    return SectionCard(
      title: 'Notifications',
      icon: Icons.notifications_outlined,
      children: [
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Telegram notifications'),
          subtitle: Text('$integrationState. Live delivery stays disabled until a bot token is authorized.'),
          value: _telegramEnabled,
          onChanged: (value) {
            setState(() => _telegramEnabled = value);
            _markDirty();
          },
        ),
      ],
    );
  }

  Widget _storageCard() {
    final payload = _payload;
    if (payload == null) return const SizedBox.shrink();
    return SectionCard(
      title: 'Where these settings live',
      icon: Icons.storage_outlined,
      children: [
        KeyValueRow('Storage', payload.storageKind == 'file' ? 'Backend file (persisted)' : 'Memory (resets on restart)'),
        if (payload.warning != null) KeyValueRow('Warning', payload.warning!),
        KeyValueRow('Changed', _dirty ? 'unsaved changes' : 'in sync with backend'),
        const SizedBox(height: 4),
        Text(
          payload.note,
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: 12),
        Align(
          alignment: Alignment.centerRight,
          child: FilledButton.icon(
            onPressed: (_saving || !_dirty) ? null : _save,
            icon: _saving
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.save_outlined),
            label: const Text('Save settings'),
          ),
        ),
      ],
    );
  }
}

/// Actions accepted by `POST /v1/automation/control`.
enum AutomationAction {
  start('start', 'Start'),
  pause('pause', 'Pause'),
  resume('resume', 'Resume');

  const AutomationAction(this.wireValue, this.label);
  final String wireValue;
  final String label;
}
