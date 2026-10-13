/// PART 6 §2/§3/§6/§9/§10 — the provider workspace.
///
/// One screen where an operator can:
///  - see every configured provider with its capability/readiness state,
///  - add/edit/delete a provider (custom endpoint URL + model, adapter type,
///    auth type) — the backend validates the endpoint policy,
///  - store or replace a credential (write-only; the value is never read back,
///    only masked metadata is displayed),
///  - run bounded tests (connection / text / image) that never publish,
///  - select the TEXT and IMAGE providers INDEPENDENTLY (no fallback),
///  - inspect the usage ledger and budget status.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/autopilot_api.dart';
import '../core/backend_client.dart';
import '../models/provider_models.dart';
import '../widgets/common.dart';

/// Adapter types the backend accepts (mirrors `ADAPTER_TYPES`).
const List<Map<String, String>> kAdapterChoices = <Map<String, String>>[
  {'value': 'openai_chat_completions', 'label': 'OpenAI-compatible chat'},
  {'value': 'openai_images', 'label': 'OpenAI-compatible images'},
  {'value': 'ollama_chat', 'label': 'Ollama (local)'},
];

/// Capability keys shown as indicators, in display order.
const List<String> kDisplayedCapabilities = <String>[
  'text_generation',
  'image_generation',
  'image_reference_input',
  'image_editing',
];

String capabilityLabel(String key) => switch (key) {
      'text_generation' => 'Text',
      'image_generation' => 'Image',
      'image_reference_input' => 'Reference input',
      'image_editing' => 'Image editing',
      'structured_output' => 'Structured output',
      _ => key,
    };

Color statusColor(CapabilityStatus status) => switch (status) {
      CapabilityStatus.ready => Colors.green,
      CapabilityStatus.notConfigured => Colors.grey,
      CapabilityStatus.capabilityUnsupported => Colors.grey,
      CapabilityStatus.configurationInvalid => Colors.red,
      CapabilityStatus.authenticationFailed => Colors.red,
      CapabilityStatus.testFailed => Colors.red,
      CapabilityStatus.temporarilyUnavailable => Colors.orange,
      CapabilityStatus.rateLimited => Colors.orange,
    };

class ProvidersScreen extends StatefulWidget {
  const ProvidersScreen({super.key, required this.api, this.onSignedOut});

  final AutopilotApi api;
  final VoidCallback? onSignedOut;

  @override
  State<ProvidersScreen> createState() => _ProvidersScreenState();
}

class _ProvidersScreenState extends State<ProvidersScreen> {
  ProviderWorkspacePayload? _workspace;
  UsageSummaryModel? _usage;
  bool _loading = true;
  String? _error;
  bool _busy = false;

  /// Per-provider in-flight test label, so only that button spins.
  final Map<String, String> _testing = <String, String>{};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final workspace = await widget.api.fetchProviders();
      UsageSummaryModel? usage;
      try {
        usage = await widget.api.fetchUsageSummary();
      } on ApiException {
        usage = null; // usage is informative; never blocks the workspace
      }
      if (!mounted) return;
      setState(() {
        _workspace = workspace;
        _usage = usage;
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

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  /* --- test actions ------------------------------------------------------ */

  Future<void> _runTest(ProviderView provider, String kind) async {
    setState(() => _testing[provider.id] = kind);
    try {
      final result = switch (kind) {
        'connection' => await widget.api.testProviderConnection(provider.id),
        'text' => await widget.api.testProviderText(provider.id),
        _ => await widget.api.testProviderImage(provider.id),
      };
      if (!mounted) return;
      setState(() => _testing.remove(provider.id));
      await _showTestResult(provider, result);
      await _refreshQuietly();
    } on AuthException {
      widget.onSignedOut?.call();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _testing.remove(provider.id));
      _snack(e.message);
    }
  }

  Future<void> _showTestResult(ProviderView provider, ProviderTestResult result) async {
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('${result.kind} test — ${result.status.label}'),
        content: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              StatusChip(
                label: result.ok ? 'PASSED' : 'FAILED',
                color: result.ok ? Colors.green : Colors.red,
                icon: result.ok ? Icons.check_circle_outline : Icons.cancel_outlined,
              ),
              const SizedBox(height: 8),
              Text(result.detail, style: const TextStyle(fontSize: 13)),
              if (result.text != null) ...[
                const SizedBox(height: 8),
                Text(
                  'Fixture caption (never published):',
                  style: Theme.of(context).textTheme.labelMedium,
                ),
                const SizedBox(height: 4),
                Text(result.text!.preview, style: const TextStyle(fontSize: 12.5)),
                const SizedBox(height: 4),
                Text(
                  result.text!.endsWithMandatory
                      ? 'Ends with #ai #automation ✓'
                      : 'Missing the mandatory ending!',
                  style: TextStyle(
                    fontSize: 12,
                    color: result.text!.endsWithMandatory ? Colors.green : Colors.red,
                  ),
                ),
              ],
              if (result.image != null) ...[
                const SizedBox(height: 8),
                Text(
                  'Fixture image (never published):',
                  style: Theme.of(context).textTheme.labelMedium,
                ),
                const SizedBox(height: 4),
                Text(
                  '${result.image!.mimeType} · ${result.image!.width}×${result.image!.height}',
                  style: const TextStyle(fontSize: 12.5),
                ),
                if (result.image!.previewDataUrl != null) ...[
                  const SizedBox(height: 8),
                  Image.network(
                    result.image!.previewDataUrl!,
                    height: 120,
                    errorBuilder: (_, _, _) => const Text('Preview unavailable'),
                  ),
                ],
              ],
              const SizedBox(height: 8),
              Text(result.note, style: Theme.of(context).textTheme.bodySmall),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Close'),
          ),
        ],
      ),
    );
  }

  /* --- selection --------------------------------------------------------- */

  Future<void> _saveSelection({
    required String? textProviderId,
    required String? imageProviderId,
  }) async {
    setState(() => _busy = true);
    try {
      await widget.api.saveProviderSelection(
        textProviderId: textProviderId,
        imageProviderId: imageProviderId,
      );
      _snack('Selection saved. There is no automatic fallback.');
      await _refreshQuietly();
    } on AuthException {
      widget.onSignedOut?.call();
    } on ApiException catch (e) {
      _snack(e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /* --- add / edit / delete ---------------------------------------------- */

  Future<void> _openEditor({ProviderView? existing}) async {
    final saved = await showDialog<bool>(
      context: context,
      builder: (context) => _ProviderEditorDialog(
        api: widget.api,
        existing: existing,
      ),
    );
    if (saved == true) {
      _snack(existing == null ? 'Provider added.' : 'Provider updated.');
      await _refreshQuietly();
    }
  }

  Future<void> _openSecretDialog(ProviderView provider) async {
    final changed = await showDialog<bool>(
      context: context,
      builder: (context) => _SecretDialog(api: widget.api, provider: provider),
    );
    if (changed == true) {
      _snack('Credential saved on the backend (encrypted, never displayed).');
      await _refreshQuietly();
    }
  }

  Future<void> _delete(ProviderView provider) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Delete "${provider.displayName}"?'),
        content: Text(
          'The provider configuration and its stored credential are removed. '
          'If it is selected for generation, deselect it first.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    setState(() => _busy = true);
    try {
      await widget.api.deleteProvider(provider.id);
      _snack('Provider deleted.');
      await _refreshQuietly();
    } on AuthException {
      widget.onSignedOut?.call();
    } on ApiException catch (e) {
      _snack(e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _refreshQuietly() async {
    try {
      final workspace = await widget.api.fetchProviders();
      UsageSummaryModel? usage;
      try {
        usage = await widget.api.fetchUsageSummary();
      } on ApiException {
        usage = _usage;
      }
      if (!mounted) return;
      setState(() {
        _workspace = workspace;
        _usage = usage;
      });
    } on AuthException {
      widget.onSignedOut?.call();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
    }
  }

  /* --- build ------------------------------------------------------------- */

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('AI providers'),
        actions: [
          IconButton(
            tooltip: 'Reload',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: _buildBody(),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _busy ? null : () => _openEditor(),
        icon: const Icon(Icons.add_rounded),
        label: const Text('Add provider'),
      ),
    );
  }

  Widget _buildBody() {
    if (_loading && _workspace == null) {
      return const LoadingState(label: 'Loading providers…');
    }
    if (_workspace == null && _error != null) {
      return ErrorStateView(message: _error!, onRetry: _load);
    }
    final workspace = _workspace!;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 88),
        children: [
          AlwaysOnBanner(
            message:
                'Text and image providers are selected independently. When a '
                'provider fails, the backend reports the error — it never '
                'switches provider or falls back to a mock.',
          ),
          if (_error != null) InlineErrorBanner(message: _error!, onRetry: _load),
          _selectionCard(workspace),
          ...workspace.providers.map((provider) => _providerCard(provider)),
          if (workspace.providers.isEmpty)
            const EmptyStateView(
              icon: Icons.smart_toy_outlined,
              title: 'No providers configured',
              message:
                  'Add an OpenAI-compatible or Ollama endpoint, store its '
                  'credential, run a test, then select it for text or image '
                  'generation.',
            ),
          if (_usage != null) _usageCard(_usage!),
          const SizedBox(height: 32),
        ],
      ),
    );
  }

  Widget _selectionCard(ProviderWorkspacePayload workspace) {
    final selection = workspace.selection;
    final textProviders = workspace.providers
        .where((p) => p.enabled && p.capabilities['text_generation'] == true)
        .toList();
    final imageProviders = workspace.providers
        .where((p) => p.enabled && p.capabilities['image_generation'] == true)
        .toList();
    return SectionCard(
      title: 'Generation providers',
      icon: Icons.tune_rounded,
      trailing: _busy ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : null,
      children: [
        DropdownButtonFormField<String?>(
          key: ValueKey<String>('text-select-${selection.textProviderId ?? 'none'}'),
          initialValue: selection.textProviderId,
          decoration: const InputDecoration(
            labelText: 'Text (captions) provider',
            helperText: 'Null = environment default (clearly labelled, not a fallback).',
            border: OutlineInputBorder(),
            prefixIcon: Icon(Icons.notes_rounded),
          ),
          items: [
            const DropdownMenuItem<String?>(
              value: null,
              child: Text('Environment default'),
            ),
            ...textProviders.map(
              (p) => DropdownMenuItem<String?>(value: p.id, child: Text(p.displayName)),
            ),
          ],
          onChanged: _busy
              ? null
              : (value) => _saveSelection(
                    textProviderId: value,
                    imageProviderId: selection.imageProviderId,
                  ),
        ),
        const SizedBox(height: 12),
        DropdownButtonFormField<String?>(
          key: ValueKey<String>('image-select-${selection.imageProviderId ?? 'none'}'),
          initialValue: selection.imageProviderId,
          decoration: const InputDecoration(
            labelText: 'Image provider',
            helperText: 'Selected independently from the text provider.',
            border: OutlineInputBorder(),
            prefixIcon: Icon(Icons.image_rounded),
          ),
          items: [
            const DropdownMenuItem<String?>(
              value: null,
              child: Text('Environment default'),
            ),
            ...imageProviders.map(
              (p) => DropdownMenuItem<String?>(value: p.id, child: Text(p.displayName)),
            ),
          ],
          onChanged: _busy
              ? null
              : (value) => _saveSelection(
                    textProviderId: selection.textProviderId,
                    imageProviderId: value,
                  ),
        ),
        const SizedBox(height: 8),
        Text(
          'Fallback policy: ${selection.fallback}. ${selection.note}',
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
    );
  }

  Widget _providerCard(ProviderView provider) {
    final testing = _testing[provider.id];
    return SectionCard(
      title: provider.displayName,
      icon: Icons.smart_toy_outlined,
      trailing: StatusChip(
        label: provider.enabled ? 'Enabled' : 'Disabled',
        color: provider.enabled ? Colors.green : Colors.grey,
      ),
      children: [
        KeyValueRow('Adapter', provider.adapterLabel),
        KeyValueRow('Endpoint', provider.baseUrl),
        KeyValueRow('Model', provider.model),
        if (provider.selectedFor.isNotEmpty)
          KeyValueRow('Selected for', provider.selectedFor.join(' + ')),
        const SizedBox(height: 8),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final key in kDisplayedCapabilities)
              if (provider.capabilities[key] == true)
                StatusChip(
                  label: capabilityLabel(key),
                  color: statusColor(provider.probeFor(key).status),
                  tooltip: provider.probeFor(key).detail,
                ),
          ],
        ),
        const SizedBox(height: 8),
        _readinessRows(provider),
        const SizedBox(height: 8),
        _secretRow(provider),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            OutlinedButton.icon(
              onPressed: testing == null ? () => _runTest(provider, 'connection') : null,
              icon: const Icon(Icons.link_rounded, size: 18),
              label: Text(testing == 'connection' ? 'Testing…' : 'Test connection'),
            ),
            if (provider.capabilities['text_generation'] == true)
              OutlinedButton.icon(
                onPressed: testing == null ? () => _runTest(provider, 'text') : null,
                icon: const Icon(Icons.notes_rounded, size: 18),
                label: Text(testing == 'text' ? 'Testing…' : 'Test text'),
              ),
            if (provider.capabilities['image_generation'] == true)
              OutlinedButton.icon(
                onPressed: testing == null ? () => _runTest(provider, 'image') : null,
                icon: const Icon(Icons.image_rounded, size: 18),
                label: Text(testing == 'image' ? 'Testing…' : 'Test image'),
              ),
            TextButton.icon(
              onPressed: _busy ? null : () => _openEditor(existing: provider),
              icon: const Icon(Icons.edit_rounded, size: 18),
              label: const Text('Edit'),
            ),
            TextButton.icon(
              onPressed: _busy ? null : () => _delete(provider),
              icon: const Icon(Icons.delete_outline_rounded, size: 18),
              label: const Text('Delete'),
            ),
          ],
        ),
      ],
    );
  }

  Widget _readinessRows(ProviderView provider) {
    final rows = <Widget>[
      _probeRow('Configuration', provider.probeFor('configuration')),
      _probeRow('Authentication', provider.probeFor('authentication')),
      if (provider.capabilities['text_generation'] == true)
        _probeRow('Text generation', provider.probeFor('text_generation')),
      if (provider.capabilities['image_generation'] == true)
        _probeRow('Image generation', provider.probeFor('image_generation')),
    ];
    return Column(children: rows);
  }

  Widget _probeRow(String label, CapabilityProbe probe) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 132,
            child: Text(
              label,
              style: Theme.of(context)
                  .textTheme
                  .labelMedium
                  ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
            ),
          ),
          StatusChip(label: probe.status.label, color: statusColor(probe.status)),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              probe.detail,
              style: Theme.of(context).textTheme.bodySmall,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }

  Widget _secretRow(ProviderView provider) {
    final secret = provider.secret;
    final Widget value;
    if (!secret.keyConfigured) {
      value = Text(
        'Server has no SECRETS_ENCRYPTION_KEY — credentials cannot be stored.',
        style: TextStyle(fontSize: 12.5, color: Theme.of(context).colorScheme.error),
      );
    } else if (!secret.present) {
      value = const Text('No credential stored.', style: TextStyle(fontSize: 12.5));
    } else {
      value = Text(
        'Stored · ${secret.masked ?? '••••'} (value never displayed)',
        style: const TextStyle(fontSize: 12.5, fontFamily: 'monospace'),
      );
    }
    return Row(
      children: [
        Expanded(child: value),
        if (secret.keyConfigured)
          TextButton.icon(
            onPressed: _busy ? null : () => _openSecretDialog(provider),
            icon: const Icon(Icons.key_rounded, size: 18),
            label: Text(secret.present ? 'Replace key' : 'Store key'),
          ),
        if (secret.keyConfigured && secret.present)
          IconButton(
            tooltip: 'Delete credential',
            onPressed: _busy ? null : () => _deleteSecret(provider),
            icon: const Icon(Icons.key_off_rounded, size: 18),
          ),
      ],
    );
  }

  Future<void> _deleteSecret(ProviderView provider) async {
    setState(() => _busy = true);
    try {
      await widget.api.deleteProviderSecret(provider.id);
      _snack('Credential deleted.');
      await _refreshQuietly();
    } on AuthException {
      widget.onSignedOut?.call();
    } on ApiException catch (e) {
      _snack(e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _usageCard(UsageSummaryModel usage) {
    final day = usage.day;
    final budget = usage.budget;
    return SectionCard(
      title: 'Usage & budget',
      icon: Icons.account_balance_wallet_outlined,
      children: [
        KeyValueRow('Today (WIB)', '${day.requests} request(s)'),
        KeyValueRow('Failures today', '${day.failures}'),
        KeyValueRow(
          'Known cost today',
          '\$${day.knownCostUsd.toStringAsFixed(4)}',
        ),
        KeyValueRow(
          'Unknown cost',
          '${day.unknownCostRequests} request(s) — cost not reported',
        ),
        const Divider(),
        KeyValueRow(
          'Daily budget',
          budget.dailyBudgetUsd == null
              ? 'Not configured (unlimited)'
              : '\$${budget.dailyBudgetUsd!.toStringAsFixed(2)} · '
                  'spent \$${budget.day.spentUsd.toStringAsFixed(4)}',
        ),
        KeyValueRow(
          'Monthly budget',
          budget.monthlyBudgetUsd == null
              ? 'Not configured (unlimited)'
              : '\$${budget.monthlyBudgetUsd!.toStringAsFixed(2)} · '
                  'spent \$${budget.month.spentUsd.toStringAsFixed(4)}',
        ),
        if (budget.blocked)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: StatusChip(
              label: 'Generation blocked (${budget.blockedScope ?? 'budget'})',
              color: Colors.red,
              icon: Icons.block_rounded,
            ),
          ),
        const SizedBox(height: 8),
        Text(
          usage.note,
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
    );
  }
}

/* ========================================================================== */
/*  Add / edit dialog                                                        */
/* ========================================================================== */

class _ProviderEditorDialog extends StatefulWidget {
  const _ProviderEditorDialog({required this.api, this.existing});

  final AutopilotApi api;
  final ProviderView? existing;

  @override
  State<_ProviderEditorDialog> createState() => _ProviderEditorDialogState();
}

class _ProviderEditorDialogState extends State<_ProviderEditorDialog> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _name;
  late final TextEditingController _displayName;
  late final TextEditingController _baseUrl;
  late final TextEditingController _model;
  String _adapterType = kAdapterChoices.first['value']!;
  String _authType = 'bearer';
  bool _saving = false;
  String? _error;
  List<String> _issues = const [];

  bool get _isEdit => widget.existing != null;

  @override
  void initState() {
    super.initState();
    final existing = widget.existing;
    _name = TextEditingController(text: existing?.name ?? '');
    _displayName = TextEditingController(text: existing?.displayName ?? '');
    _baseUrl = TextEditingController(text: existing?.baseUrl ?? '');
    _model = TextEditingController(text: existing?.model ?? '');
    if (existing != null) {
      _adapterType = existing.adapterType;
      _authType = existing.authType;
    }
  }

  @override
  void dispose() {
    _name.dispose();
    _displayName.dispose();
    _baseUrl.dispose();
    _model.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _saving = true;
      _error = null;
      _issues = const [];
    });
    final payload = <String, dynamic>{
      'name': _name.text.trim(),
      'displayName': _displayName.text.trim(),
      'adapterType': _adapterType,
      'baseUrl': _baseUrl.text.trim(),
      'model': _model.text.trim(),
      'auth': <String, dynamic>{'type': _authType},
    };
    try {
      if (_isEdit) {
        await widget.api.updateProvider(widget.existing!.id, payload);
      } else {
        await widget.api.createProvider(payload);
      }
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on AuthException {
      if (!mounted) return;
      setState(() => _saving = false);
      _error = 'Session expired. Sign in again.';
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

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(_isEdit ? 'Edit provider' : 'Add provider'),
      content: SizedBox(
        width: 420,
        child: Form(
          key: _formKey,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (_error != null) ...[
                  InlineErrorBanner(message: _error!),
                ],
                if (_issues.isNotEmpty)
                  InlineErrorBanner(message: 'Rejected:\n${_issues.join('\n')}'),
                TextFormField(
                  controller: _name,
                  enabled: !_isEdit,
                  decoration: const InputDecoration(
                    labelText: 'ID (lowercase slug)',
                    helperText: 'e.g. openrouter, ollama-local. Immutable.',
                    border: OutlineInputBorder(),
                    prefixIcon: Icon(Icons.tag_rounded),
                  ),
                  validator: (value) {
                    final text = value?.trim() ?? '';
                    if (text.isEmpty) return 'Required';
                    if (!RegExp(r'^[a-z0-9][a-z0-9_-]{0,63}$').hasMatch(text)) {
                      return 'lowercase letters, digits, - and _ only';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _displayName,
                  decoration: const InputDecoration(
                    labelText: 'Display name',
                    border: OutlineInputBorder(),
                    prefixIcon: Icon(Icons.badge_rounded),
                  ),
                  validator: (value) =>
                      (value?.trim().isEmpty ?? true) ? 'Required' : null,
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: _adapterType,
                  decoration: const InputDecoration(
                    labelText: 'Adapter',
                    helperText: 'Declares which capabilities the endpoint has.',
                    border: OutlineInputBorder(),
                    prefixIcon: Icon(Icons.hub_rounded),
                  ),
                  items: [
                    for (final choice in kAdapterChoices)
                      DropdownMenuItem<String>(
                        value: choice['value'],
                        child: Text(choice['label']!),
                      ),
                  ],
                  onChanged: (value) {
                    if (value == null) return;
                    setState(() => _adapterType = value);
                  },
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _baseUrl,
                  decoration: const InputDecoration(
                    labelText: 'Base URL',
                    helperText:
                        'http(s) only. Private/metadata addresses are rejected '
                        'unless explicitly allowlisted.',
                    border: OutlineInputBorder(),
                    prefixIcon: Icon(Icons.link_rounded),
                  ),
                  validator: (value) {
                    final text = value?.trim() ?? '';
                    if (text.isEmpty) return 'Required';
                    final uri = Uri.tryParse(text);
                    if (uri == null || !uri.hasAbsolutePath) return 'Invalid URL';
                    if (uri.scheme != 'http' && uri.scheme != 'https') {
                      return 'Only http/https are allowed';
                    }
                    if (uri.userInfo.isNotEmpty) return 'Userinfo is not allowed';
                    return null;
                  },
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _model,
                  decoration: const InputDecoration(
                    labelText: 'Model',
                    border: OutlineInputBorder(),
                    prefixIcon: Icon(Icons.psychology_rounded),
                  ),
                  validator: (value) =>
                      (value?.trim().isEmpty ?? true) ? 'Required' : null,
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: _authType,
                  decoration: const InputDecoration(
                    labelText: 'Authentication',
                    helperText: 'The credential itself is stored separately, encrypted.',
                    border: OutlineInputBorder(),
                    prefixIcon: Icon(Icons.lock_rounded),
                  ),
                  items: const [
                    DropdownMenuItem<String>(
                      value: 'bearer',
                      child: Text('Bearer token (Authorization: Bearer …)'),
                    ),
                    DropdownMenuItem<String>(
                      value: 'header',
                      child: Text('Custom header (x-api-key, …)'),
                    ),
                    DropdownMenuItem<String>(
                      value: 'none',
                      child: Text('None (local Ollama)'),
                    ),
                  ],
                  onChanged: (value) {
                    if (value == null) return;
                    setState(() => _authType = value);
                  },
                ),
              ],
            ),
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _saving ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton.icon(
          onPressed: _saving ? null : _save,
          icon: _saving
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.save_rounded),
          label: Text(_isEdit ? 'Save changes' : 'Add provider'),
        ),
      ],
    );
  }
}

/* ========================================================================== */
/*  Credential dialog (write-only)                                            */
/* ========================================================================== */

class _SecretDialog extends StatefulWidget {
  const _SecretDialog({required this.api, required this.provider});

  final AutopilotApi api;
  final ProviderView provider;

  @override
  State<_SecretDialog> createState() => _SecretDialogState();
}

class _SecretDialogState extends State<_SecretDialog> {
  final _formKey = GlobalKey<FormState>();
  final _secretController = TextEditingController();
  bool _obscure = true;
  bool _saving = false;
  String? _error;
  List<String> _issues = const [];

  @override
  void dispose() {
    _secretController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _saving = true;
      _error = null;
      _issues = const [];
    });
    try {
      await widget.api.saveProviderSecret(
        widget.provider.id,
        _secretController.text,
      );
      // Clear the field immediately: the value must not linger in memory.
      _secretController.clear();
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on AuthException {
      if (!mounted) return;
      setState(() => _saving = false);
      _error = 'Session expired. Sign in again.';
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

  @override
  Widget build(BuildContext context) {
    final secret = widget.provider.secret;
    return AlertDialog(
      title: Text('Credential — ${widget.provider.displayName}'),
      content: SizedBox(
        width: 420,
        child: Form(
          key: _formKey,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (_error != null) InlineErrorBanner(message: _error!),
              if (_issues.isNotEmpty)
                InlineErrorBanner(message: 'Rejected:\n${_issues.join('\n')}'),
              if (secret.present)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(
                    'Currently stored: ${secret.masked ?? '••••'}',
                    style: const TextStyle(fontSize: 12.5, fontFamily: 'monospace'),
                  ),
                ),
              TextFormField(
                controller: _secretController,
                obscureText: _obscure,
                autocorrect: false,
                enableSuggestions: false,
                keyboardType: TextInputType.visiblePassword,
                inputFormatters: [
                  FilteringTextInputFormatter.deny(RegExp(r'\s')),
                ],
                decoration: InputDecoration(
                  labelText: 'API key / token',
                  helperText:
                      'Sent once, encrypted on the backend, and never returned '
                      'by any endpoint.',
                  border: const OutlineInputBorder(),
                  prefixIcon: const Icon(Icons.key_rounded),
                  suffixIcon: IconButton(
                    tooltip: _obscure ? 'Show' : 'Hide',
                    onPressed: () => setState(() => _obscure = !_obscure),
                    icon: Icon(
                      _obscure ? Icons.visibility_off_rounded : Icons.visibility_rounded,
                    ),
                  ),
                ),
                validator: (value) {
                  final text = value ?? '';
                  if (text.isEmpty) return 'Required';
                  if (text.length > 500) return 'Too long';
                  return null;
                },
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _saving ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton.icon(
          onPressed: _saving ? null : _save,
          icon: _saving
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.save_rounded),
          label: const Text('Store credential'),
        ),
      ],
    );
  }
}
