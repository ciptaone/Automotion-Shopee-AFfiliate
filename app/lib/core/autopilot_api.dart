import 'backend_client.dart';
import 'app_config.dart';
import '../models/api_models.dart';
import '../models/automation_models.dart';
import '../models/provider_models.dart';

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

  /* --- Part 3: catalog + pipeline -------------------------------------- */

  /// Categories derived from the ACTUAL imported catalog (never hardcoded).
  Future<CatalogCategoriesPayload> fetchCatalogCategories() async =>
      CatalogCategoriesPayload.fromJson(
          await client.getAuthed('/v1/catalog/categories'));

  /// Catalog totals + recent imports (for the empty-catalog / import status UX).
  Future<CatalogStatusPayload> fetchCatalogStatus() async =>
      CatalogStatusPayload.fromJson(
          await client.getAuthed('/v1/catalog/status'));

  /// Explicitly run the content pipeline for a slot. Generation only — this
  /// NEVER publishes to Facebook or Threads (the backend does not either).
  Future<PipelineRunResult> runPipeline({
    String? slot,
    bool regenerate = false,
  }) async {
    final payload = <String, dynamic>{
      if (slot != null && slot.isNotEmpty) 'slot': slot,
      if (regenerate) 'regenerate': true,
    };
    return PipelineRunResult.fromJson(
        await client.postAuthed('/v1/pipeline/run', payload));
  }

  /// Recent pipeline slot records (stage, image count, blockers).
  Future<List<PipelineSlotSummary>> fetchPipelineSlots({int limit = 20}) async {
    final body = await client.getAuthed('/v1/pipeline/slots?limit=$limit');
    final raw = body['slots'];
    if (raw is List) {
      return raw
          .whereType<Map<String, dynamic>>()
          .map(PipelineSlotSummary.fromJson)
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

  /* --- PART 6 §2/§3: provider workspace --------------------------------- */

  /// Full provider workspace: providers, independent selection, capabilities.
  Future<ProviderWorkspacePayload> fetchProviders() async =>
      ProviderWorkspacePayload.fromJson(
          await client.getAuthed('/v1/providers'));

  /// Create a provider. [payload] follows the backend's provider input schema.
  Future<ProviderView> createProvider(Map<String, dynamic> payload) async {
    final body = await client.postAuthed('/v1/providers', payload);
    return ProviderView.fromJson(
        (body['provider'] as Map<String, dynamic>?) ?? const {});
  }

  /// Update a provider (full re-validation on the backend).
  Future<ProviderView> updateProvider(
    String id,
    Map<String, dynamic> payload,
  ) async {
    final body = await client.putAuthed('/v1/providers/$id', payload);
    return ProviderView.fromJson(
        (body['provider'] as Map<String, dynamic>?) ?? const {});
  }

  /// Delete a provider (409 when it is still selected).
  Future<bool> deleteProvider(String id) async {
    final body = await client.deleteAuthed('/v1/providers/$id');
    return body['deleted'] == true;
  }

  /// Store/replace the credential. The value goes IN and is never read back.
  Future<ProviderSecretMetadata> saveProviderSecret(String id, String secret) async {
    final body = await client.putAuthed('/v1/providers/$id/secret', {'secret': secret});
    return ProviderSecretMetadata.fromJson(
        (body['secret'] as Map<String, dynamic>?) ?? const {});
  }

  /// Delete the credential (never returns the value).
  Future<ProviderSecretMetadata> deleteProviderSecret(String id) async {
    final body = await client.deleteAuthed('/v1/providers/$id/secret');
    return ProviderSecretMetadata.fromJson(
        (body['secret'] as Map<String, dynamic>?) ?? const {});
  }

  /// Independent text/image selection. Ids may be null (env default).
  Future<ProviderSelection> saveProviderSelection({
    String? textProviderId,
    String? imageProviderId,
  }) async =>
      ProviderSelection.fromJson(await client.putAuthed(
        '/v1/providers/selection',
        <String, dynamic>{
          'textProviderId': textProviderId,
          'imageProviderId': imageProviderId,
        },
      ));

  /// Bounded connection test — never generates content, never publishes.
  Future<ProviderTestResult> testProviderConnection(String id) async =>
      ProviderTestResult.fromJson(
          await client.postAuthed('/v1/providers/$id/test/connection', const {}));

  /// Bounded fixture caption test — never publishes.
  Future<ProviderTestResult> testProviderText(String id) async =>
      ProviderTestResult.fromJson(
          await client.postAuthed('/v1/providers/$id/test/text', const {}));

  /// Bounded fixture image test — never publishes.
  Future<ProviderTestResult> testProviderImage(String id) async =>
      ProviderTestResult.fromJson(
          await client.postAuthed('/v1/providers/$id/test/image', const {}));

  /* --- PART 6 §10: usage + budget --------------------------------------- */

  /// Per-request usage ledger + budget status (honest cost classification).
  Future<UsageSummaryModel> fetchUsageSummary() async =>
      UsageSummaryModel.fromJson(
          await client.getAuthed('/v1/usage/summary'));
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

/* -------------------------------------------------------------------------- */
/*  Part 3: catalog status + pipeline run results                             */
/* -------------------------------------------------------------------------- */

/// Catalog totals + recent import batches.
class CatalogStatusPayload {
  const CatalogStatusPayload({
    required this.total,
    required this.eligible,
    required this.categories,
    required this.storage,
    required this.warning,
    required this.recentImports,
  });

  final int total;
  final int eligible;
  final int categories;

  /// `"file"` (persisted) or `"memory"` (resets on restart).
  final String storage;
  final String? warning;
  final List<CatalogImportBatch> recentImports;

  bool get isEmpty => total == 0;

  factory CatalogStatusPayload.fromJson(Map<String, dynamic> json) =>
      CatalogStatusPayload(
        total: (json['total'] as num?)?.toInt() ?? 0,
        eligible: (json['eligible'] as num?)?.toInt() ?? 0,
        categories: (json['categories'] as num?)?.toInt() ?? 0,
        storage: json['storage'] as String? ?? '',
        warning: json['warning'] as String?,
        recentImports: (json['recentImports'] as List?)
                ?.whereType<Map<String, dynamic>>()
                .map(CatalogImportBatch.fromJson)
                .toList() ??
            const [],
      );
}

class CatalogImportBatch {
  const CatalogImportBatch({
    required this.id,
    required this.filename,
    required this.format,
    required this.importedAt,
    required this.totalRows,
    required this.newProducts,
    required this.updatedProducts,
    required this.rejected,
    required this.duplicatesRemoved,
    required this.urlDuplicatesSkipped,
  });

  final String id;
  final String filename;
  final String format;
  final String importedAt;
  final int totalRows;
  final int newProducts;
  final int updatedProducts;
  final int rejected;
  final int duplicatesRemoved;
  final int urlDuplicatesSkipped;

  factory CatalogImportBatch.fromJson(Map<String, dynamic> json) =>
      CatalogImportBatch(
        id: json['id'] as String? ?? '',
        filename: json['filename'] as String? ?? '',
        format: json['format'] as String? ?? '',
        importedAt: json['importedAt'] as String? ?? '',
        totalRows: (json['totalRows'] as num?)?.toInt() ?? 0,
        newProducts: (json['newProducts'] as num?)?.toInt() ?? 0,
        updatedProducts: (json['updatedProducts'] as num?)?.toInt() ?? 0,
        rejected: (json['rejected'] as num?)?.toInt() ?? 0,
        duplicatesRemoved: (json['duplicatesRemoved'] as num?)?.toInt() ?? 0,
        urlDuplicatesSkipped: (json['urlDuplicatesSkipped'] as num?)?.toInt() ?? 0,
      );
}

/// Result of an explicit pipeline run (generation only, never publication).
class PipelineRunResult {
  const PipelineRunResult({
    required this.slotKey,
    required this.stage,
    required this.actions,
    required this.preview,
    required this.note,
  });

  final String slotKey;
  final String stage;
  final List<String> actions;
  final ContentPreview preview;
  final String note;

  factory PipelineRunResult.fromJson(Map<String, dynamic> json) =>
      PipelineRunResult(
        slotKey: json['slotKey'] as String? ?? '',
        stage: json['stage'] as String? ?? '',
        actions: (json['actions'] as List?)
                ?.map((e) => e.toString())
                .toList() ??
            const [],
        preview: json['preview'] is Map<String, dynamic>
            ? ContentPreview.fromJson(json['preview'] as Map<String, dynamic>)
            : ContentPreview.fromJson(const {}),
        note: json['note'] as String? ?? '',
      );
}

/// One slot record from the pipeline list endpoint.
class PipelineSlotSummary {
  const PipelineSlotSummary({
    required this.slotKey,
    required this.stage,
    required this.productName,
    required this.imageCount,
    required this.assets,
    required this.captions,
    required this.validationPassed,
    required this.blockers,
    required this.attempts,
    required this.publishReady,
    required this.updatedAt,
  });

  final String slotKey;
  final String stage;
  final String? productName;
  final int imageCount;
  final int assets;
  final int captions;
  final bool validationPassed;
  final List<PipelineBlocker> blockers;
  final int attempts;
  final bool publishReady;
  final String updatedAt;

  factory PipelineSlotSummary.fromJson(Map<String, dynamic> json) =>
      PipelineSlotSummary(
        slotKey: json['slotKey'] as String? ?? '',
        stage: json['stage'] as String? ?? '',
        productName: json['productName'] as String?,
        imageCount: (json['imageCount'] as num?)?.toInt() ?? 0,
        assets: (json['assets'] as num?)?.toInt() ?? 0,
        captions: (json['captions'] as num?)?.toInt() ?? 0,
        validationPassed: json['validationPassed'] as bool? ?? false,
        blockers: (json['blockers'] as List?)
                ?.whereType<Map<String, dynamic>>()
                .map(PipelineBlocker.fromJson)
                .toList() ??
            const [],
        attempts: (json['attempts'] as num?)?.toInt() ?? 0,
        publishReady: json['publishReady'] as bool? ?? false,
        updatedAt: json['updatedAt'] as String? ?? '',
      );
}
