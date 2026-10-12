import 'package:flutter/material.dart';

import '../core/backend_client.dart';
import '../core/secure_store.dart';

/// Simple, secure sign-in: the operator pastes the install key that was issued
/// together with the backend. The key is redeemed for a short-lived session
/// token and stored in platform-secure storage.
class LoginScreen extends StatefulWidget {
  const LoginScreen({
    super.key,
    required this.backendUrl,
    required this.onLoggedIn,
  });

  final String backendUrl;
  final VoidCallback onLoggedIn;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _controller = TextEditingController();
  final _formKey = GlobalKey<FormState>();

  late final BackendClient _client;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _client = BackendClient(baseUrl: widget.backendUrl);
    _prefill();
  }

  Future<void> _prefill() async {
    final saved = await SecureStore.instance.readInstallKey();
    if (saved != null && saved.isNotEmpty && mounted) {
      _controller.text = saved;
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final key = _controller.text.trim();
      await _client.redeemInstallKey(key);
      await SecureStore.instance.saveInstallKey(key);
      if (!mounted) return;
      widget.onLoggedIn();
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Could not reach the backend.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _formKey,
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Icon(Icons.rocket_launch_rounded,
                        size: 64, color: scheme.primary),
                    const SizedBox(height: 16),
                    Text(
                      'Shopee Affiliate\nAutopilot',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                            fontWeight: FontWeight.w700,
                          ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Connect to your always-on backend',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                            color: scheme.onSurfaceVariant,
                          ),
                    ),
                    const SizedBox(height: 32),
                    TextFormField(
                      controller: _controller,
                      obscureText: true,
                      autocorrect: false,
                      enableSuggestions: false,
                      decoration: const InputDecoration(
                        labelText: 'Install key',
                        hintText: 'Paste the key issued with your backend',
                        prefixIcon: Icon(Icons.key_rounded),
                        border: OutlineInputBorder(),
                      ),
                      validator: (v) =>
                          (v == null || v.trim().isEmpty) ? 'Install key is required' : null,
                      onFieldSubmitted: (_) => _submit(),
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: 12),
                      _ErrorBanner(message: _error!),
                    ],
                    const SizedBox(height: 20),
                    FilledButton(
                      onPressed: _busy ? null : _submit,
                      child: _busy
                          ? const SizedBox(
                              height: 20,
                              width: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Text('Connect'),
                    ),
                    const SizedBox(height: 24),
                    Text(
                      'Backend: ${widget.backendUrl}',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.labelSmall?.copyWith(
                            color: scheme.outline,
                          ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'This app stores no Shopee, Meta, AI or storage secrets.',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.labelSmall?.copyWith(
                            color: scheme.outline,
                          ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.message});
  final String message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: scheme.errorContainer,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          Icon(Icons.error_outline_rounded, color: scheme.onErrorContainer),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              message,
              style: TextStyle(color: scheme.onErrorContainer, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }
}
