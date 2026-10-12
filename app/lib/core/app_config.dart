/// Application configuration.
///
/// SECURITY INVARIANT: this file must never contain a Shopee, Meta/Facebook,
/// Threads, AI-provider, database or S3 secret. The backend base URL is the only
/// build-time value, and it is not a credential.
///
/// The backend URL can be overridden at runtime without rebuilding by using
/// `--dart-define=BACKEND_URL=https://your-host`. The default targets a local
/// development server so the app works out of the box against `npm run dev`.
class AppConfig {
  AppConfig._();

  static const String backendUrl = String.fromEnvironment(
    'BACKEND_URL',
    defaultValue: 'http://10.0.2.2:8080', // Android emulator loopback -> host.
  );

  static const String appName = 'Shopee Affiliate Autopilot';
  static const String appVersion = '0.1.0';
}
