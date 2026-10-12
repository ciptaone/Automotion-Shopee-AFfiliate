import 'package:flutter/material.dart';

import '../core/autopilot_api.dart';
import 'dashboard_screen.dart';
import 'history_screen.dart';
import 'integrations_screen.dart';
import 'preview_screen.dart';
import 'settings_screen.dart';

/// Root shell after sign-in: five tabs over the control surface.
///
/// Tabs are kept alive in an [IndexedStack] so switching back to the dashboard
/// does not throw away its state or re-trigger a network call.
class HomeShell extends StatefulWidget {
  const HomeShell({
    super.key,
    required this.api,
    this.onSignedOut,
  });

  final AutopilotApi api;
  final VoidCallback? onSignedOut;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  static const _destinations = <({String label, IconData icon})>[
    (label: 'Dashboard', icon: Icons.dashboard_outlined),
    (label: 'Settings', icon: Icons.tune_outlined),
    (label: 'Preview', icon: Icons.preview_outlined),
    (label: 'History', icon: Icons.history_outlined),
    (label: 'Services', icon: Icons.hub_outlined),
  ];

  @override
  Widget build(BuildContext context) {
    final api = widget.api;
    final onSignedOut = widget.onSignedOut;

    return Scaffold(
      body: IndexedStack(
        index: _index,
        children: [
          DashboardScreen(api: api, onSignOut: onSignedOut),
          SettingsScreen(api: api, onSignedOut: onSignedOut),
          PreviewScreen(api: api, onSignedOut: onSignedOut),
          HistoryScreen(api: api, onSignedOut: onSignedOut),
          IntegrationsScreen(api: api, onSignedOut: onSignedOut),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (value) => setState(() => _index = value),
        labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
        destinations: [
          for (final destination in _destinations)
            NavigationDestination(
              icon: Icon(destination.icon),
              selectedIcon: Icon(destination.icon, fill: 1),
              label: destination.label,
            ),
        ],
      ),
    );
  }
}
