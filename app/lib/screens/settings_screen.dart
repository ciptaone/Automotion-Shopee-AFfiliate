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
  final _dailyBudgetController = TextEditingController();
  final _monthlyBudgetController = TextEditingController();
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

  /* --- Part 6 §7: daily posting target (3 or 4 per WIB day) ------------ */
  int _dailyPostTarget = 4;

  /* --- Part 3: product selection -------------------------------------- */
  SelectionMode _selectionMode = SelectionMode.auto;
  final List<String> _selectedCategoryIds = <String>[];
  List<CatalogCategory> _categories = const [];
  bool _categoriesLoading = true;
  String? _categoriesError;

  @override
  void initState() {
    super.initState();
    _load();
    _loadCategories();
  }

  @override
  void dispose() {
    _intervalController.dispose();
    _slotsController.dispose();
    _dailyBudgetController.dispose();
    _monthlyBudgetController.dispose();
    super.dispose();
  }

  SettingsConstraints get _constraints =>
      _payload?.constraints ??
      const SettingsConstraints(
        minIntervalMinutes: 15,
        maxIntervalMinutes: 720,
        maxSlotsPerDay: 24,
        imageCountPolicies: ImageCountPolicy.wireValues,
        minDailyPostTarget: 3,
        maxDailyPostTarget: 4,
        defaultDailyPostTarget: 4,
        postingWindows: <String>[
          '06:00-07:00 WIB',
          '12:00-13:00 WIB',
          '16:00-17:00 WIB',
          '19:00-20:00 WIB',
        ],
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
    _selectionMode = settings.selectionMode;
    _dailyPostTarget = settings.dailyPostTarget;
    _dailyBudgetController.text =
        settings.dailyBudgetUsd == null ? '' : _fmtBudget(settings.dailyBudgetUsd);
    _monthlyBudgetController.text =
        settings.monthlyBudgetUsd == null ? '' : _fmtBudget(settings.monthlyBudgetUsd);
    _selectedCategoryIds
      ..clear()
      ..addAll(settings.selectedCategoryIds);
    // If the catalog categories are already loaded, drop any selection ids
    // that no longer exist (the backend would reject them on save anyway).
    if (_categories.isNotEmpty) {
      final known = _categories.map((c) => c.id).toSet();
      _selectedCategoryIds.removeWhere((id) => !known.contains(id));
    }
  }

  /// Loads the categories that ACTUALLY exist in the imported catalog.
  /// Empty catalog => empty list + friendly guidance (never a hardcoded list).
  Future<void> _loadCategories() async {
    setState(() {
      _categoriesLoading = true;
      _categoriesError = null;
    });
    try {
      final payload = await widget.api.fetchCatalogCategories();
      if (!mounted) return;
      setState(() {
        _categories = payload.categories;
        _categoriesLoading = false;
      });
      // Drop ids that no longer exist in the catalog so we never send an
      // invalid selection to the backend (covers categories loading after
      // the settings payload).
      if (_selectedCategoryIds.isNotEmpty) {
        final known = payload.categories.map((c) => c.id).toSet();
        _selectedCategoryIds.removeWhere((id) => !known.contains(id));
      }
    } on AuthException {
      widget.onSignedOut?.call();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _categoriesLoading = false;
        _categoriesError = e.message;
      });
    }
  }

  void _markDirty() {
    if (!_dirty) setState(() => _dirty = true);
  }

  /// Trim trailing zeros: 1.50 -> "1.50", 2.0 -> "2".
  static String _fmtBudget(double? value) {
    if (value == null) return '';
    final fixed = value.toStringAsFixed(2);
    return fixed.endsWith('.00')
        ? fixed.substring(0, fixed.length - 3)
        : fixed;
  }

  int get _interval => int.tryParse(_intervalController.text.trim()) ?? 0;
  int get _slots => int.tryParse(_slotsController.text.trim()) ?? 0;

  double? get _dailyBudget => double.tryParse(_dailyBudgetController.text.trim());
  double? get _monthlyBudget => double.tryParse(_monthlyBudgetController.text.trim());

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
    // PART 6 §10: budgets must be valid numbers when provided (empty = none).
    final budgetIssues = <String>[
      if (_dailyBudgetController.text.trim().isNotEmpty && _dailyBudget == null)
        'Daily budget must be a non-negative number (or empty for no limit).',
      if (_monthlyBudgetController.text.trim().isNotEmpty && _monthlyBudget == null)
        'Monthly budget must be a non-negative number (or empty for no limit).',
      if (_dailyBudget != null && _dailyBudget! < 0)
        'Daily budget must not be negative.',
      if (_monthlyBudget != null && _monthlyBudget! < 0)
        'Monthly budget must not be negative.',
    ];
    if (budgetIssues.isNotEmpty) {
      setState(() {
        _issues = budgetIssues;
        _error = null;
      });
      return;
    }
    // Local mirror of the backend rule: selected-categories needs categories.
    if (_selectionMode == SelectionMode.selectedCategories &&
        _selectedCategoryIds.isEmpty) {
      setState(() {
        _issues = const [
          'Select at least one category, or switch back to Auto.',
        ];
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
      'selectionMode': _selectionMode.wireValue,
      'selectedCategoryIds': _selectionMode == SelectionMode.auto
          ? <String>[]
          : List<String>.unmodifiable(_selectedCategoryIds),
      // PART 6 §7/§10 — daily posting target and optional budgets.
      'dailyPostTarget': _dailyPostTarget,
      'dailyBudgetUsd': _dailyBudget,
      'monthlyBudgetUsd': _monthlyBudget,
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
          _dailyPlanCard(),
          _selectionCard(),
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

  /// PART 6 §7/§10 — daily posting target (3 or 4), the four WIB windows and
  /// the optional generation budgets.
  Widget _dailyPlanCard() {
    final scheme = Theme.of(context).colorScheme;
    final windows = _constraints.postingWindows;
    return SectionCard(
      title: 'Daily posting plan',
      icon: Icons.event_available_rounded,
      children: [
        Text(
          'How many posts the backend schedules per Asia/Jakarta day, inside '
          'the allowed WIB windows.',
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: scheme.onSurfaceVariant),
        ),
        const SizedBox(height: 12),
        SegmentedButton<int>(
          segments: [
            for (final target in const [3, 4])
              ButtonSegment<int>(
                value: target,
                label: Text('$target post${target == 1 ? '' : 's'}'),
              ),
          ],
          selected: {_dailyPostTarget},
          showSelectedIcon: false,
          onSelectionChanged: (selection) {
            setState(() => _dailyPostTarget = selection.first);
            _markDirty();
          },
        ),
        const SizedBox(height: 12),
        Text(
          'Posting windows (WIB):',
          style: Theme.of(context)
              .textTheme
              .labelMedium
              ?.copyWith(color: scheme.onSurfaceVariant),
        ),
        const SizedBox(height: 6),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (var i = 0; i < windows.length; i += 1)
              StatusChip(
                label: windows[i],
                color: i < _dailyPostTarget ? Colors.green : Colors.grey,
                icon: i < _dailyPostTarget
                    ? Icons.check_circle_outline_rounded
                    : Icons.remove_circle_outline_rounded,
              ),
          ],
        ),
        const SizedBox(height: 6),
        Text(
          _dailyPostTarget == 4
              ? 'All four windows are used. The first N windows of the day are selected deterministically.'
              : 'The first 3 windows (morning, midday, afternoon) are used; the evening window is skipped.',
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: scheme.onSurfaceVariant),
        ),
        const Divider(height: 24),
        TextFormField(
          controller: _dailyBudgetController,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: const InputDecoration(
            labelText: 'Daily budget (USD)',
            helperText: 'Empty = no configured limit. Generation is blocked once exhausted.',
            border: OutlineInputBorder(),
            prefixIcon: Icon(Icons.savings_outlined),
          ),
          onChanged: (_) => _markDirty(),
          validator: (value) {
            final text = (value ?? '').trim();
            if (text.isEmpty) return null;
            final parsed = double.tryParse(text);
            if (parsed == null || parsed < 0) {
              return 'Enter a non-negative number, or leave empty';
            }
            return null;
          },
        ),
        const SizedBox(height: 12),
        TextFormField(
          controller: _monthlyBudgetController,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: const InputDecoration(
            labelText: 'Monthly budget (USD)',
            helperText: 'Empty = no configured limit. Spent totals persist across restarts.',
            border: OutlineInputBorder(),
            prefixIcon: Icon(Icons.account_balance_wallet_outlined),
          ),
          onChanged: (_) => _markDirty(),
          validator: (value) {
            final text = (value ?? '').trim();
            if (text.isEmpty) return null;
            final parsed = double.tryParse(text);
            if (parsed == null || parsed < 0) {
              return 'Enter a non-negative number, or leave empty';
            }
            return null;
          },
        ),
      ],
    );
  }

  Widget _selectionCard() {
    final scheme = Theme.of(context).colorScheme;
    final usingSelected = _selectionMode == SelectionMode.selectedCategories;

    return SectionCard(
      title: 'Product selection',
      icon: Icons.category_rounded,
      children: [
        Text(
          'Choose which imported products the backend may pick from when it '
          'creates content for a slot.',
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: scheme.onSurfaceVariant),
        ),
        const SizedBox(height: 12),
        SegmentedButton<SelectionMode>(
          segments: [
            for (final mode in SelectionMode.values)
              ButtonSegment(value: mode, label: Text(mode.label)),
          ],
          selected: {_selectionMode},
          showSelectedIcon: false,
          onSelectionChanged: (selection) {
            setState(() => _selectionMode = selection.first);
            _markDirty();
          },
        ),
        const SizedBox(height: 4),
        if (!usingSelected)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              'Auto uses weighted scoring across every eligible imported '
              'category, with category diversity and recent-product avoidance. '
              'It makes no sales predictions.',
              style: Theme.of(context)
                  .textTheme
                  .bodySmall
                  ?.copyWith(color: scheme.onSurfaceVariant),
            ),
          )
        else
          ..._categoryPicker(scheme),
      ],
    );
  }

  List<Widget> _categoryPicker(ColorScheme scheme) {
    if (_categoriesLoading) {
      return [
        const SizedBox(height: 12),
        const LinearProgressIndicator(),
        const SizedBox(height: 8),
        Text(
          'Loading categories from the imported catalog…',
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: scheme.onSurfaceVariant),
        ),
      ];
    }

    if (_categoriesError != null) {
      return [
        const SizedBox(height: 12),
        InlineErrorBanner(message: 'Categories failed to load: $_categoriesError'),
        TextButton.icon(
          onPressed: _loadCategories,
          icon: const Icon(Icons.refresh_rounded, size: 18),
          label: const Text('Retry'),
        ),
      ];
    }

    if (_categories.isEmpty) {
      return [
        const SizedBox(height: 12),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: scheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(10),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'No categories yet — the catalog is empty.',
                style: Theme.of(context)
                    .textTheme
                    .titleSmall
                    ?.copyWith(fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 4),
              Text(
                'Import a Shopee affiliate feed first (backend endpoint '
                'POST /v1/catalog/import). Categories are derived from the '
                'actual imported products — this app never invents a list.',
                style: Theme.of(context)
                    .textTheme
                    .bodySmall
                    ?.copyWith(color: scheme.onSurfaceVariant),
              ),
            ],
          ),
        ),
      ];
    }

    return [
      const SizedBox(height: 8),
      Text(
        'Pick one or more categories (only these will be used):',
        style: Theme.of(context)
            .textTheme
            .bodySmall
            ?.copyWith(color: scheme.onSurfaceVariant),
      ),
      const SizedBox(height: 4),
      for (final category in _categories)
        CheckboxListTile(
          contentPadding: EdgeInsets.zero,
          dense: true,
          controlAffinity: ListTileControlAffinity.leading,
          title: Text(category.name),
          subtitle: Text(
            '${category.eligibleProductCount} eligible of '
            '${category.productCount} imported',
            style: Theme.of(context)
                .textTheme
                .bodySmall
                ?.copyWith(color: scheme.onSurfaceVariant),
          ),
          value: _selectedCategoryIds.contains(category.id),
          onChanged: (checked) {
            setState(() {
              if (checked == true) {
                _selectedCategoryIds.add(category.id);
              } else {
                _selectedCategoryIds.remove(category.id);
              }
            });
            _markDirty();
          },
        ),
      if (_selectedCategoryIds.isEmpty)
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text(
            'No category selected — slots will be skipped (never silently '
            'switched back to Auto).',
            style: Theme.of(context)
                .textTheme
                .bodySmall
                ?.copyWith(color: scheme.error),
          ),
        ),
    ];
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
