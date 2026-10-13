/// PART 6 §2/§3/§6/§9/§10 — provider workspace, test results and usage models.
///
/// Every model is nullable-safe (`?? default`) so a newer backend can never
/// crash an older APK. No model here ever holds a credential: the backend
/// returns only masked metadata (`present`, `masked`, `keyConfigured`).
library;

/// The PART 6 readiness/status vocabulary, exactly as the backend defines it.
enum CapabilityStatus {
  notConfigured('not_configured', 'Not tested yet'),
  configurationInvalid('configuration_invalid', 'Configuration invalid'),
  authenticationFailed('authentication_failed', 'Authentication failed'),
  ready('ready', 'Ready'),
  capabilityUnsupported('capability_unsupported', 'Not supported'),
  temporarilyUnavailable('temporarily_unavailable', 'Temporarily unavailable'),
  rateLimited('rate_limited', 'Rate limited'),
  testFailed('test_failed', 'Test failed');

  const CapabilityStatus(this.wireValue, this.label);

  final String wireValue;
  final String label;

  static CapabilityStatus parse(String? raw) =>
      CapabilityStatus.values.cast<CapabilityStatus?>().firstWhere(
            (value) => value?.wireValue == raw,
            orElse: () => null,
          ) ??
      CapabilityStatus.notConfigured;

  bool get isReady => this == CapabilityStatus.ready;
}

/// One readiness probe (configuration / authentication / a capability).
class CapabilityProbe {
  const CapabilityProbe({
    required this.status,
    required this.detail,
    this.testedAt,
    this.requestId,
  });

  final CapabilityStatus status;
  final String detail;
  final String? testedAt;
  final String? requestId;

  factory CapabilityProbe.fromJson(Map<String, dynamic> json) => CapabilityProbe(
        status: CapabilityStatus.parse(json['status'] as String?),
        detail: json['detail'] as String? ?? '',
        testedAt: json['testedAt'] as String?,
        requestId: json['requestId'] as String?,
      );
}

/// Capability keys the backend reports per provider.
const List<String> kProviderCapabilityKeys = <String>[
  'configuration',
  'authentication',
  'text_generation',
  'image_generation',
  'image_reference_input',
  'image_editing',
  'structured_output',
];

/// Masked credential metadata — the ONLY thing the backend ever returns about
/// a stored secret.
class ProviderSecretMetadata {
  const ProviderSecretMetadata({
    required this.present,
    required this.keyConfigured,
    this.masked,
  });

  final bool present;
  final bool keyConfigured;
  final String? masked;

  factory ProviderSecretMetadata.fromJson(Map<String, dynamic> json) =>
      ProviderSecretMetadata(
        present: json['present'] as bool? ?? false,
        keyConfigured: json['keyConfigured'] as bool? ?? false,
        masked: json['masked'] as String?,
      );
}

/// Which generation tasks a provider is selected for.
class ProviderSelection {
  const ProviderSelection({
    required this.textProviderId,
    required this.imageProviderId,
    required this.textProviderName,
    required this.imageProviderName,
    required this.fallback,
    required this.note,
  });

  final String? textProviderId;
  final String? imageProviderId;
  final String? textProviderName;
  final String? imageProviderName;

  /// Always `'none'`: the backend never silently switches provider.
  final String fallback;
  final String note;

  factory ProviderSelection.fromJson(Map<String, dynamic> json) =>
      ProviderSelection(
        textProviderId: json['textProviderId'] as String?,
        imageProviderId: json['imageProviderId'] as String?,
        textProviderName: json['textProviderName'] as String?,
        imageProviderName: json['imageProviderName'] as String?,
        fallback: json['fallback'] as String? ?? 'none',
        note: json['note'] as String? ?? '',
      );
}

/// One provider as the workspace lists it (never includes a credential).
class ProviderView {
  const ProviderView({
    required this.id,
    required this.name,
    required this.displayName,
    required this.adapterType,
    required this.adapterLabel,
    required this.baseUrl,
    required this.model,
    required this.authType,
    required this.enabled,
    required this.capabilities,
    required this.readiness,
    required this.secret,
    required this.selectedFor,
    required this.updatedAt,
  });

  final String id;
  final String name;
  final String displayName;
  final String adapterType;
  final String adapterLabel;
  final String baseUrl;
  final String model;
  final String authType;
  final bool enabled;

  /// Declared capabilities, e.g. `{'text_generation': true, ...}`.
  final Map<String, bool> capabilities;

  /// Readiness probes keyed by capability key.
  final Map<String, CapabilityProbe> readiness;

  final ProviderSecretMetadata secret;

  /// Tasks this provider is currently selected for (`text` / `image`).
  final List<String> selectedFor;

  final String updatedAt;

  factory ProviderView.fromJson(Map<String, dynamic> json) {
    final rawCapabilities = json['capabilities'];
    final rawReadiness = json['readiness'];
    return ProviderView(
      id: json['id'] as String? ?? '',
      name: json['name'] as String? ?? '',
      displayName: json['displayName'] as String? ?? '',
      adapterType: json['adapterType'] as String? ?? '',
      adapterLabel: json['adapterLabel'] as String? ?? '',
      baseUrl: json['baseUrl'] as String? ?? '',
      model: json['model'] as String? ?? '',
      authType: json['auth'] is Map<String, dynamic>
          ? ((json['auth'] as Map<String, dynamic>)['type'] as String? ?? 'none')
          : 'none',
      enabled: json['enabled'] as bool? ?? true,
      capabilities: rawCapabilities is Map<String, dynamic>
          ? rawCapabilities.map(
              (key, value) => MapEntry(key, value == true),
            )
          : const <String, bool>{},
      readiness: rawReadiness is Map<String, dynamic>
          ? rawReadiness.map(
              (key, value) => MapEntry(
                key,
                value is Map<String, dynamic>
                    ? CapabilityProbe.fromJson(value)
                    : const CapabilityProbe(
                        status: CapabilityStatus.notConfigured,
                        detail: '',
                      ),
              ),
            )
            : const <String, CapabilityProbe>{},
      secret: ProviderSecretMetadata.fromJson(
        (json['secret'] as Map<String, dynamic>?) ?? const {},
      ),
      selectedFor: (json['selectedFor'] as List?)
              ?.map((e) => e.toString())
              .toList() ??
          const <String>[],
      updatedAt: json['updatedAt'] as String? ?? '',
    );
  }

  /// Overall status tile: configuration first, then the capability a caller
  /// cares about.
  CapabilityProbe probeFor(String key) =>
      readiness[key] ??
      const CapabilityProbe(
        status: CapabilityStatus.notConfigured,
        detail: 'Not tested yet.',
      );
}

/// `GET /v1/providers` payload.
class ProviderWorkspacePayload {
  const ProviderWorkspacePayload({
    required this.providers,
    required this.selection,
    required this.storage,
    required this.secretsStorage,
    required this.capabilities,
    required this.statuses,
    required this.note,
  });

  final List<ProviderView> providers;
  final ProviderSelection selection;
  final String storage;
  final String secretsStorage;
  final List<String> capabilities;
  final List<String> statuses;
  final String note;

  factory ProviderWorkspacePayload.fromJson(Map<String, dynamic> json) =>
      ProviderWorkspacePayload(
        providers: ((json['providers'] as List?) ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(ProviderView.fromJson)
            .toList(),
        selection: ProviderSelection.fromJson(
          (json['selection'] as Map<String, dynamic>?) ?? const {},
        ),
        storage: json['storage'] as String? ?? '',
        secretsStorage: json['secretsStorage'] as String? ?? '',
        capabilities: (json['capabilities'] as List?)
                ?.map((e) => e.toString())
                .toList() ??
            const <String>[],
        statuses: (json['statuses'] as List?)
                ?.map((e) => e.toString())
                .toList() ??
            const <String>[],
        note: json['note'] as String? ?? '',
      );
}

/// Bounded test result for text generation (fixture data only).
class ProviderTestText {
  const ProviderTestText({
    required this.preview,
    required this.chars,
    required this.model,
    required this.endsWithMandatory,
  });

  final String preview;
  final int chars;
  final String model;
  final bool endsWithMandatory;

  factory ProviderTestText.fromJson(Map<String, dynamic> json) =>
      ProviderTestText(
        preview: json['preview'] as String? ?? '',
        chars: (json['chars'] as num?)?.toInt() ?? 0,
        model: json['model'] as String? ?? '',
        endsWithMandatory: json['endsWithMandatory'] as bool? ?? false,
      );
}

/// Bounded test result for image generation (fixture data only).
class ProviderTestImage {
  const ProviderTestImage({
    required this.mimeType,
    required this.width,
    required this.height,
    required this.byteLength,
    this.previewDataUrl,
  });

  final String mimeType;
  final int width;
  final int height;
  final int byteLength;
  final String? previewDataUrl;

  factory ProviderTestImage.fromJson(Map<String, dynamic> json) =>
      ProviderTestImage(
        mimeType: json['mimeType'] as String? ?? '',
        width: (json['width'] as num?)?.toInt() ?? 0,
        height: (json['height'] as num?)?.toInt() ?? 0,
        byteLength: (json['byteLength'] as num?)?.toInt() ?? 0,
        previewDataUrl: json['previewDataUrl'] as String?,
      );
}

/// `POST /v1/providers/{id}/test/{connection,text,image}` payload.
class ProviderTestResult {
  const ProviderTestResult({
    required this.ok,
    required this.kind,
    required this.providerId,
    required this.status,
    required this.detail,
    required this.durationMs,
    required this.requestId,
    required this.readiness,
    required this.note,
    this.text,
    this.image,
  });

  final bool ok;
  final String kind;
  final String providerId;
  final CapabilityStatus status;
  final String detail;
  final int durationMs;
  final String? requestId;
  final Map<String, CapabilityProbe> readiness;
  final String note;
  final ProviderTestText? text;
  final ProviderTestImage? image;

  factory ProviderTestResult.fromJson(Map<String, dynamic> json) {
    final rawReadiness = json['readiness'];
    final rawText = json['text'];
    final rawImage = json['image'];
    return ProviderTestResult(
      ok: json['ok'] as bool? ?? false,
      kind: json['kind'] as String? ?? '',
      providerId: json['providerId'] as String? ?? '',
      status: CapabilityStatus.parse(json['status'] as String?),
      detail: json['detail'] as String? ?? '',
      durationMs: (json['durationMs'] as num?)?.toInt() ?? 0,
      requestId: json['requestId'] as String?,
      readiness: rawReadiness is Map<String, dynamic>
          ? rawReadiness.map(
              (key, value) => MapEntry(
                key,
                value is Map<String, dynamic>
                    ? CapabilityProbe.fromJson(value)
                    : const CapabilityProbe(
                        status: CapabilityStatus.notConfigured,
                        detail: '',
                      ),
              ),
            )
          : const <String, CapabilityProbe>{},
      note: json['note'] as String? ?? '',
      text: rawText is Map<String, dynamic>
          ? ProviderTestText.fromJson(rawText)
          : null,
      image: rawImage is Map<String, dynamic>
          ? ProviderTestImage.fromJson(rawImage)
          : null,
    );
  }
}

/* ========================================================================== */
/*  Usage / budget (§10)                                                     */
/* ========================================================================== */

/// One per-request usage ledger entry.
class UsageRecordModel {
  const UsageRecordModel({
    required this.at,
    required this.providerName,
    required this.model,
    required this.operation,
    required this.status,
    required this.costKind,
    this.providerId,
    this.adapterType,
    this.requestId,
    this.inputTokens,
    this.outputTokens,
    this.images,
    this.costUsd,
    this.errorCode,
  });

  final String at;
  final String providerName;
  final String model;
  final String operation;
  final String status;

  /// `actual` | `estimated` | `unknown` — never silently treated as $0.
  final String costKind;
  final String? providerId;
  final String? adapterType;
  final String? requestId;
  final int? inputTokens;
  final int? outputTokens;
  final int? images;
  final double? costUsd;
  final String? errorCode;

  factory UsageRecordModel.fromJson(Map<String, dynamic> json) =>
      UsageRecordModel(
        at: json['at'] as String? ?? '',
        providerName: json['providerName'] as String? ?? '',
        model: json['model'] as String? ?? '',
        operation: json['operation'] as String? ?? '',
        status: json['status'] as String? ?? '',
        costKind: json['costKind'] as String? ?? 'unknown',
        providerId: json['providerId'] as String?,
        adapterType: json['adapterType'] as String?,
        requestId: json['requestId'] as String?,
        inputTokens: (json['inputTokens'] as num?)?.toInt(),
        outputTokens: (json['outputTokens'] as num?)?.toInt(),
        images: (json['images'] as num?)?.toInt(),
        costUsd: (json['costUsd'] as num?)?.toDouble(),
        errorCode: json['errorCode'] as String?,
      );
}

/// Aggregated totals for a window (day / month).
class UsageTotalsModel {
  const UsageTotalsModel({
    required this.requests,
    required this.failures,
    required this.images,
    required this.knownCostUsd,
    required this.unknownCostRequests,
    this.inputTokens,
    this.outputTokens,
  });

  final int requests;
  final int failures;
  final int images;

  /// Sum of provider-reported (actual or estimated) costs only.
  final double knownCostUsd;

  /// Requests whose cost could not be determined — surfaced, never $0.
  final int unknownCostRequests;
  final int? inputTokens;
  final int? outputTokens;

  factory UsageTotalsModel.fromJson(Map<String, dynamic> json) =>
      UsageTotalsModel(
        requests: (json['requests'] as num?)?.toInt() ?? 0,
        failures: (json['failures'] as num?)?.toInt() ?? 0,
        images: (json['images'] as num?)?.toInt() ?? 0,
        knownCostUsd: (json['knownCostUsd'] as num?)?.toDouble() ?? 0,
        unknownCostRequests: (json['unknownCostRequests'] as num?)?.toInt() ?? 0,
        inputTokens: (json['inputTokens'] as num?)?.toInt(),
        outputTokens: (json['outputTokens'] as num?)?.toInt(),
      );
}

/// Budget window: what is configured and what is spent.
class BudgetWindowModel {
  const BudgetWindowModel({
    required this.from,
    required this.to,
    required this.spentUsd,
    required this.budgetUsd,
    required this.exhausted,
  });

  final String from;
  final String to;
  final double spentUsd;
  final double? budgetUsd;
  final bool exhausted;

  factory BudgetWindowModel.fromJson(Map<String, dynamic> json) =>
      BudgetWindowModel(
        from: json['from'] as String? ?? '',
        to: json['to'] as String? ?? '',
        spentUsd: (json['spentUsd'] as num?)?.toDouble() ?? 0,
        budgetUsd: (json['budgetUsd'] as num?)?.toDouble(),
        exhausted: json['exhausted'] as bool? ?? false,
      );
}

/// `budget` block of the usage summary.
class BudgetStatusModel {
  const BudgetStatusModel({
    required this.timezone,
    required this.dailyBudgetUsd,
    required this.monthlyBudgetUsd,
    required this.day,
    required this.month,
    required this.blocked,
    required this.blockedScope,
    required this.unknownCostRequests,
    required this.note,
  });

  final String timezone;
  final double? dailyBudgetUsd;
  final double? monthlyBudgetUsd;
  final BudgetWindowModel day;
  final BudgetWindowModel month;
  final bool blocked;
  final String? blockedScope;
  final int unknownCostRequests;
  final String note;

  factory BudgetStatusModel.fromJson(Map<String, dynamic> json) =>
      BudgetStatusModel(
        timezone: json['timezone'] as String? ?? 'Asia/Jakarta',
        dailyBudgetUsd: (json['dailyBudgetUsd'] as num?)?.toDouble(),
        monthlyBudgetUsd: (json['monthlyBudgetUsd'] as num?)?.toDouble(),
        day: BudgetWindowModel.fromJson(
          (json['day'] as Map<String, dynamic>?) ?? const {},
        ),
        month: BudgetWindowModel.fromJson(
          (json['month'] as Map<String, dynamic>?) ?? const {},
        ),
        blocked: json['blocked'] as bool? ?? false,
        blockedScope: json['blockedScope'] as String?,
        unknownCostRequests: (json['unknownCostRequests'] as num?)?.toInt() ?? 0,
        note: json['note'] as String? ?? '',
      );
}

/// `GET /v1/usage/summary` payload.
class UsageSummaryModel {
  const UsageSummaryModel({
    required this.timezone,
    required this.storage,
    required this.day,
    required this.month,
    required this.budget,
    required this.recent,
    required this.note,
  });

  final String timezone;
  final String storage;
  final UsageTotalsModel day;
  final UsageTotalsModel month;
  final BudgetStatusModel budget;
  final List<UsageRecordModel> recent;
  final String note;

  factory UsageSummaryModel.fromJson(Map<String, dynamic> json) =>
      UsageSummaryModel(
        timezone: json['timezone'] as String? ?? 'Asia/Jakarta',
        storage: json['storage'] as String? ?? '',
        day: UsageTotalsModel.fromJson(
          (json['day'] as Map<String, dynamic>?) ?? const {},
        ),
        month: UsageTotalsModel.fromJson(
          (json['month'] as Map<String, dynamic>?) ?? const {},
        ),
        budget: BudgetStatusModel.fromJson(
          (json['budget'] as Map<String, dynamic>?) ?? const {},
        ),
        recent: ((json['recent'] as List?) ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(UsageRecordModel.fromJson)
            .toList(),
        note: json['note'] as String? ?? '',
      );
}
