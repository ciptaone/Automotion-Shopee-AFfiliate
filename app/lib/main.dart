import 'package:flutter/material.dart';

import 'core/app_config.dart';
import 'screens/dashboard_screen.dart';
import 'screens/login_screen.dart';
import 'core/secure_store.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const AutopilotApp());
}

/// Root widget for the Shopee Affiliate Autopilot control app.
///
/// SECURITY: this app holds NO Shopee, Meta, AI-provider, database or storage
/// secrets. The only credential it ever touches is an operator-issued install
/// key, which it exchanges for a short-lived backend session token. All
/// privileged API calls (publishing, feed access, AI, storage) run server-side.
class AutopilotApp extends StatelessWidget {
  const AutopilotApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Shopee Affiliate Autopilot',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFFEE4D2D), // Shopee orange
          brightness: Brightness.light,
        ),
        scaffoldBackgroundColor: const Color(0xFFF7F7F9),
        appBarTheme: const AppBarTheme(centerTitle: false, elevation: 0),
        cardTheme: CardThemeData(
          elevation: 0,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          color: Colors.white,
        ),
      ),
      home: const _Bootstrap(),
    );
  }
}

/// Decides between login and dashboard based on whether a session exists.
class _Bootstrap extends StatefulWidget {
  const _Bootstrap();

  @override
  State<_Bootstrap> createState() => _BootstrapState();
}

class _BootstrapState extends State<_Bootstrap> {
  late Future<bool> _hasSession;

  @override
  void initState() {
    super.initState();
    _hasSession = SecureStore.instance.hasSession();
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<bool>(
      future: _hasSession,
      builder: (context, snapshot) {
        if (!snapshot.hasData) {
          return const Scaffold(body: Center(child: CircularProgressIndicator()));
        }
        return snapshot.data == true
            ? const DashboardScreen()
            : LoginScreen(
                backendUrl: AppConfig.backendUrl,
                onLoggedIn: () => setState(() {}),
              );
      },
    );
  }
}
