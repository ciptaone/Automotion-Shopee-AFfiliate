import 'backend_client.dart';
import 'app_config.dart';
import '../models/api_models.dart';
import '../models/automation_models.dart';

/// Typed facade over the backend's Part 1 + Part 2 endpoint contracts.
///
/// Screens depend on this instead of raw JSON, and tests inject a
/// [BackendClient] backed by `package:http`'s MockClient so no test ever opens
/// a socket.
class AutopilotApi {
  AutopilotApi(this.client);

  /// Production wiring: the backend URL comes from `--dart-define=BACKEND_URL`.
  factory AutopilotApi.forEnvironment() =>
      AutopilotApi(BackendClient(baseUrl: AppConfig.backendUrl));

  final BackendClient client;

  String get baseUrl => client.baseUrl;

  /* --- auth ------------------------------------------------------------- */

  Future<TokenResponse> redeemInstallKey(String installKey) =>
      client.redeemInstallKey(installKey);

  Future<void> signOut() => client.signOut();

  Future<bool> ping() => client.ping();

  /* --- read ------------------------------------------------------------- */

  Future<HealthReport> fetchHealth() async =>
      HealthReport.fromJson(await client.getPublic('/health'));

  Future<AutomationStatus> fetchAutomationStatus() async => AutomationStatus.fromJson(
      await client.getAuthed('/v1/automation/status'));

  Future<SettingsPayload> fetchSettings() async =>
      SettingsPayload.fromJson(await client.getAuthed('/v1/settings'));

  Future<ContentPreview> fetchContentPreview({String? slot}) async {
    final path = slot == null || slot.isEmpty
        ? '/v1/content/preview'
        : '/v1/content/preview?slot=${Uri.encodeQueryComponent(slot)}';
    return ContentPreview.fromJson(await client.getAuthed(path));
  }

  Future<PublishHistory> fetchPublishHistory({int limit = 20}) async =>
      PublishHistory.fromJson(
          await client.getAuthed('/v1/history/publishes?limit=$limit'));

  Future<List<IntegrationHealthEntry>> fetchIntegrations() async {
    final body = await client.getPublic('/v1/meta/integrations');
    final raw = body['integrations'];
    if (raw is List) {
      return raw
          .whereType<Map<String, dynamic>>()
          .map(IntegrationHealthEntry.fromJson)
          .toList();
    }
    return const [];
  }

  /* --- write ------------------------------------------------------------ */

  /// Persist a settings patch. Throws [ServerException] with per-field issues
  /// when the backend rejects it.
  Future<SettingsPayload> saveSettings(Map<String, dynamic> patch) async =>
      SettingsPayload.fromJson(await client.putAuthed('/v1/settings', patch));

  /// `action` must be one of `start`, `pause`, `resume`.
  Future<ControlResult> controlAutomation(String action) async =>
      ControlResult.fromJson(
          await client.postAuthed('/v1/automation/control', {'action': action}));
}

/// Publishing history payload (fixture-backed until the pipeline exists).
class PublishHistory {
  const PublishHistory({
    required this.items,
    required this.source,
    required this.note,
  });

  final List<PublishRecord> items;
  final String source;
  final String note;

  bool get isFixture => source == 'fixture';

  factory PublishHistory.fromJson(Map<String, dynamic> json) => PublishHistory(
        items: (json['items'] as List?)
                ?.whereType<Map<String, dynamic>>()
                .map(PublishRecord.fromJson)
                .toList() ??
            const [],
        source: json['source'] as String? ?? '',
        note: json['note'] as String? ?? '',
      );
}
