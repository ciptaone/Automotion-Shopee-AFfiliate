/// Data models for the Part 2 control surface (automation, settings, preview,
/// history, integration health).
///
/// Hand-written, nullable-safe parsers: a newer backend must never crash an
/// older APK. No model ever contains a credential field.
library;

import 'api_models.dart';
import 'image_count_policy.dart';

/* -------------------------------------------------------------------------- */
/*  Automation state & settings                                               */
/* -------------------------------------------------------------------------- */

enum AutomationState {
  running('running', 'Running'),
  paused('paused', 'Paused');

  const AutomationState(this.wireValue, this.label);
  final String wireValue;
  final String label;

  static AutomationState parse(String? raw) {
    for (final value in AutomationState.values) {
      if (value.wireValue == raw) return value;
    }
    return AutomationState.paused;
  }
}

/// How the backend picks which product feeds a content slot.
enum SelectionMode {
  /// Auto: across ALL eligible imported categories (the default).
  auto('auto', 'Auto (all eligible categories)'),

  /// Only within the operator's explicitly chosen categories.
  selectedCategories(
    'selected_categories',
    'Selected categories only',
  );

  const SelectionMode(this.wireValue, this.label);
  final String wireValue;
  final String label;

  static SelectionMode parse(String? raw) {
    for (final value in SelectionMode.values) {
      if (value.wireValue == raw) return value;
    }
    return SelectionMode.auto;
  }
}

class AutomationSettings {
  const AutomationSettings({
    required this.intervalMinutes,
    required this.maxSlotsPerDay,
    required this.facebookEnabled,
    required this.threadsEnabled,
    required this.imageCountPolicy,
    required this.telegramNotificationsEnabled,
    required this.automationState,
    required this.selectionMode,
    required this.selectedCategoryIds,
    this.dailyPostTarget = 4,
    this.dailyBudgetUsd,
    this.monthlyBudgetUsd,
  });

  /// Locked defaults, mirrored from the backend contract.
  static const AutomationSettings defaults = AutomationSettings(
    intervalMinutes: 60,
    maxSlotsPerDay: 24,
    facebookEnabled: true,
    threadsEnabled: true,
    imageCountPolicy: ImageCountPolicy.defaultValue,
    telegramNotificationsEnabled: true,
    automationState: AutomationState.paused,
    selectionMode: SelectionMode.auto,
    selectedCategoryIds: <String>[],
    // PART 6 §7: four WIB windows per day by default.
    dailyPostTarget: 4,
    // PART 6 §10: budgets are opt-in; null = no configured limit.
    dailyBudgetUsd: null,
    monthlyBudgetUsd: null,
  );

  final int intervalMinutes;
  final int maxSlotsPerDay;
  final bool facebookEnabled;
  final bool threadsEnabled;
  final ImageCountPolicy imageCountPolicy;
  final bool telegramNotificationsEnabled;
  final AutomationState automationState;

  /// Product selection mode (Part 3): auto across all eligible categories, or
  /// restricted to the operator's chosen categories.
  final SelectionMode selectionMode;

  /// Stable category ids from the imported catalog (selected-categories mode).
  final List<String> selectedCategoryIds;

  /// PART 6 §7 — posts per Asia/Jakarta day (3 or 4, default 4).
  final int dailyPostTarget;

  /// PART 6 §10 — optional daily generation budget in USD (null = unlimited).
  final double? dailyBudgetUsd;

  /// PART 6 §10 — optional monthly generation budget in USD (null = unlimited).
  final double? monthlyBudgetUsd;

  factory AutomationSettings.fromJson(Map<String, dynamic> json) =>
      AutomationSettings(
        intervalMinutes: (json['intervalMinutes'] as num?)?.toInt() ?? defaults.intervalMinutes,
        maxSlotsPerDay: (json['maxSlotsPerDay'] as num?)?.toInt() ?? defaults.maxSlotsPerDay,
        facebookEnabled: json['facebookEnabled'] as bool? ?? defaults.facebookEnabled,
        threadsEnabled: json['threadsEnabled'] as bool? ?? defaults.threadsEnabled,
        imageCountPolicy:
            ImageCountPolicy.parse(json['imageCountPolicy'] as String?),
        telegramNotificationsEnabled:
            json['telegramNotificationsEnabled'] as bool? ?? true,
        automationState: AutomationState.parse(json['automationState'] as String?),
        selectionMode: SelectionMode.parse(json['selectionMode'] as String?),
        selectedCategoryIds: (json['selectedCategoryIds'] as List?)
                ?.map((e) => e.toString())
                .toList() ??
            const [],
        dailyPostTarget: _clampDailyTarget(
          (json['dailyPostTarget'] as num?)?.toInt(),
        ),
        dailyBudgetUsd: (json['dailyBudgetUsd'] as num?)?.toDouble(),
        monthlyBudgetUsd: (json['monthlyBudgetUsd'] as num?)?.toDouble(),
      );

  /// Backend rule: only 3 or 4 posts per day are allowed; anything else falls
  /// back to the default so an older/newer backend can never break the APK.
  static int _clampDailyTarget(int? raw) {
    if (raw == 3) return 3;
    if (raw == 4) return 4;
    return defaults.dailyPostTarget;
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        'intervalMinutes': intervalMinutes,
        'maxSlotsPerDay': maxSlotsPerDay,
        'facebookEnabled': facebookEnabled,
        'threadsEnabled': threadsEnabled,
        'imageCountPolicy': imageCountPolicy.wireValue,
        'telegramNotificationsEnabled': telegramNotificationsEnabled,
        'automationState': automationState.wireValue,
        'selectionMode': selectionMode.wireValue,
        'selectedCategoryIds': selectedCategoryIds,
        'dailyPostTarget': dailyPostTarget,
        'dailyBudgetUsd': dailyBudgetUsd,
        'monthlyBudgetUsd': monthlyBudgetUsd,
      };

  AutomationSettings copyWith({
    int? intervalMinutes,
    int? maxSlotsPerDay,
    bool? facebookEnabled,
    bool? threadsEnabled,
    ImageCountPolicy? imageCountPolicy,
    bool? telegramNotificationsEnabled,
    AutomationState? automationState,
    SelectionMode? selectionMode,
    List<String>? selectedCategoryIds,
    int? dailyPostTarget,
    double? dailyBudgetUsd,
    double? monthlyBudgetUsd,
    bool clearDailyBudget = false,
    bool clearMonthlyBudget = false,
  }) =>
      AutomationSettings(
        intervalMinutes: intervalMinutes ?? this.intervalMinutes,
        maxSlotsPerDay: maxSlotsPerDay ?? this.maxSlotsPerDay,
        facebookEnabled: facebookEnabled ?? this.facebookEnabled,
        threadsEnabled: threadsEnabled ?? this.threadsEnabled,
        imageCountPolicy: imageCountPolicy ?? this.imageCountPolicy,
        telegramNotificationsEnabled:
            telegramNotificationsEnabled ?? this.telegramNotificationsEnabled,
        automationState: automationState ?? this.automationState,
        selectionMode: selectionMode ?? this.selectionMode,
        selectedCategoryIds:
            selectedCategoryIds ?? this.selectedCategoryIds,
        dailyPostTarget: dailyPostTarget ?? this.dailyPostTarget,
        dailyBudgetUsd: clearDailyBudget ? null : (dailyBudgetUsd ?? this.dailyBudgetUsd),
        monthlyBudgetUsd:
            clearMonthlyBudget ? null : (monthlyBudgetUsd ?? this.monthlyBudgetUsd),
      );

  /// Client-side mirror of the backend's cross-field rule.
  String? get scheduleIssue {
    if (intervalMinutes * maxSlotsPerDay > 24 * 60) {
      return '$maxSlotsPerDay slots every $intervalMinutes minutes exceed one 24-hour day.';
    }
    return null;
  }

  /// Client-side mirror of the backend's selection rule: switching to
  /// selected-categories mode requires at least one category.
  String? get selectionIssue {
    if (selectionMode == SelectionMode.selectedCategories &&
        selectedCategoryIds.isEmpty) {
      return 'Select at least one category before switching to selected-categories mode.';
    }
    return null;
  }
}

class SettingsConstraints {
  const SettingsConstraints({
    required this.minIntervalMinutes,
    required this.maxIntervalMinutes,
    required this.maxSlotsPerDay,
    required this.imageCountPolicies,
    required this.minDailyPostTarget,
    required this.maxDailyPostTarget,
    required this.defaultDailyPostTarget,
    required this.postingWindows,
  });

  final int minIntervalMinutes;
  final int maxIntervalMinutes;
  final int maxSlotsPerDay;
  final List<String> imageCountPolicies;

  /// PART 6 §7 — daily posting target bounds (3..4) and the four WIB windows.
  final int minDailyPostTarget;
  final int maxDailyPostTarget;
  final int defaultDailyPostTarget;
  final List<String> postingWindows;

  factory SettingsConstraints.fromJson(Map<String, dynamic> json) =>
      SettingsConstraints(
        minIntervalMinutes: (json['minIntervalMinutes'] as num?)?.toInt() ?? 15,
        maxIntervalMinutes: (json['maxIntervalMinutes'] as num?)?.toInt() ?? 720,
        maxSlotsPerDay: (json['maxSlotsPerDay'] as num?)?.toInt() ?? 24,
        imageCountPolicies: (json['imageCountPolicies'] as List?)
                ?.map((e) => e.toString())
                .toList() ??
            const [],
        minDailyPostTarget: (json['minDailyPostTarget'] as num?)?.toInt() ?? 3,
        maxDailyPostTarget: (json['maxDailyPostTarget'] as num?)?.toInt() ?? 4,
        defaultDailyPostTarget:
            (json['defaultDailyPostTarget'] as num?)?.toInt() ?? 4,
        postingWindows: (json['postingWindows'] as List?)
                ?.map((e) => e.toString())
                .toList() ??
            const [
              '06:00-07:00 WIB',
              '12:00-13:00 WIB',
              '16:00-17:00 WIB',
              '19:00-20:00 WIB',
            ],
      );
}

class SettingsPayload {
  const SettingsPayload({
    required this.settings,
    required this.storageKind,
    required this.warning,
    required this.constraints,
    required this.note,
  });

  final AutomationSettings settings;

  /// `"file"` (persisted server-side) or `"memory"` (resets on restart).
  final String storageKind;

  /// Non-fatal load problem reported by the backend, if any.
  final String? warning;
  final SettingsConstraints constraints;
  final String note;

  bool get isPersisted => storageKind == 'file';

  factory SettingsPayload.fromJson(Map<String, dynamic> json) => SettingsPayload(
        settings: AutomationSettings.fromJson(
          (json['settings'] as Map<String, dynamic>?) ?? const {},
        ),
        storageKind: json['storage'] is Map<String, dynamic>
            ? ((json['storage'] as Map<String, dynamic>)['kind'] as String? ?? '')
            : '',
        warning: json['warning'] as String?,
        constraints: SettingsConstraints.fromJson(
          (json['constraints'] as Map<String, dynamic>?) ?? const {},
        ),
        note: json['note'] as String? ?? '',
      );
}

class ControlResult {
  const ControlResult({
    required this.action,
    required this.changed,
    required this.state,
    required this.settings,
    required this.note,
  });

  final String action;
  final bool changed;
  final AutomationState state;
  final AutomationSettings settings;
  final String note;

  factory ControlResult.fromJson(Map<String, dynamic> json) => ControlResult(
        action: json['action'] as String? ?? '',
        changed: json['changed'] as bool? ?? false,
        state: AutomationState.parse(json['state'] as String?),
        settings: AutomationSettings.fromJson(
          (json['settings'] as Map<String, dynamic>?) ?? const {},
        ),
        note: json['note'] as String? ?? '',
      );
}

/* -------------------------------------------------------------------------- */
/*  Automation status (dashboard)                                             */
/* -------------------------------------------------------------------------- */

class PublicationCounts {
  const PublicationCounts({
    required this.succeeded,
    required this.failed,
    required this.retrying,
    required this.source,
  });

  final int succeeded;
  final int failed;
  final int retrying;

  /// Always `job_queue` — counters are runtime facts, never fixtures.
  final String source;

  factory PublicationCounts.fromJson(Map<String, dynamic> json) => PublicationCounts(
        succeeded: (json['succeeded'] as num?)?.toInt() ?? 0,
        failed: (json['failed'] as num?)?.toInt() ?? 0,
        retrying: (json['retrying'] as num?)?.toInt() ?? 0,
        source: json['source'] as String? ?? '',
      );
}

class AutomationStatus {
  const AutomationStatus({
    required this.state,
    required this.degraded,
    required this.degradedReasons,
    required this.timezone,
    required this.today,
    required this.slotsScheduled,
    required this.slotsUsed,
    required this.slotsRemaining,
    required this.publications,
    required this.latestContentNote,
    required this.recentActivity,
    required this.serverTime,
  });

  final AutomationState state;
  final bool degraded;
  final List<String> degradedReasons;
  final String timezone;
  final String today;
  final int slotsScheduled;
  final int slotsUsed;
  final int slotsRemaining;
  final PublicationCounts publications;

  /// The backend always reports `latestContent: null` until the generation
  /// pipeline exists; this note explains that state to the operator.
  final String latestContentNote;
  final List<JobRecord> recentActivity;
  final String serverTime;

  double get slotFill => slotsScheduled == 0 ? 0 : slotsUsed / slotsScheduled;

  factory AutomationStatus.fromJson(Map<String, dynamic> json) => AutomationStatus(
        state: AutomationState.parse(json['state'] as String?),
        degraded: json['degraded'] as bool? ?? false,
        degradedReasons: (json['degradedReasons'] as List?)
                ?.map((e) => e.toString())
                .toList() ??
            const [],
        timezone: json['timezone'] as String? ?? '',
        today: json['today'] as String? ?? '',
        slotsScheduled: (json['slotsScheduled'] as num?)?.toInt() ?? 0,
        slotsUsed: (json['slotsUsed'] as num?)?.toInt() ?? 0,
        slotsRemaining: (json['slotsRemaining'] as num?)?.toInt() ?? 0,
        publications: PublicationCounts.fromJson(
          (json['publications'] as Map<String, dynamic>?) ?? const {},
        ),
        latestContentNote: json['latestContentNote'] as String? ?? '',
        recentActivity: (json['recentActivity'] as List?)
                ?.whereType<Map<String, dynamic>>()
                .map(JobRecord.fromJson)
                .toList() ??
            const [],
        serverTime: json['serverTime'] as String? ?? '',
      );
}

/* -------------------------------------------------------------------------- */
/*  Content preview (fixture)                                                 */
/* -------------------------------------------------------------------------- */

class ContentProduct {
  const ContentProduct({
    required this.name,
    required this.affiliateUrl,
    required this.source,
    this.sourceProductId,
    this.categoryId,
    this.referenceImageUrl,
    this.referenceAvailable,
    this.referenceUnavailableReason,
  });

  final String name;
  final String affiliateUrl;

  /// `fixture` until the real pipeline exists.
  final String source;

  /* --- PART 4: product record is the source of truth --- */

  /// Marketplace id of the reserved product (null on fixtures).
  final String? sourceProductId;
  final String? categoryId;

  /// Reference image the generation was grounded on (null when none).
  final String? referenceImageUrl;

  /// PART 4 — whether a reference image is available for this product.
  ///
  /// `null` means the backend did not report it (Part 2 fixture payloads);
  /// the UI must not claim availability either way in that case.
  final bool? referenceAvailable;

  /// Why generation is blocked when [referenceAvailable] is false.
  final String? referenceUnavailableReason;

  bool get referenceMissing => referenceAvailable == false;

  factory ContentProduct.fromJson(Map<String, dynamic> json) => ContentProduct(
        name: json['name'] as String? ?? '',
        affiliateUrl: json['affiliateUrl'] as String? ?? '',
        source: json['source'] as String? ?? '',
        sourceProductId: json['sourceProductId'] as String?,
        categoryId: json['categoryId'] as String?,
        referenceImageUrl: json['referenceImageUrl'] as String?,
        referenceAvailable: json['referenceAvailable'] as bool?,
        referenceUnavailableReason: json['referenceUnavailableReason'] as String?,
      );
}

class ContentCaption {
  const ContentCaption({
    required this.fullText,
    required this.hashtags,
    required this.source,
    this.mandatoryFinalHashtags,
    this.mandatoryEndingPresent,
  });

  final String fullText;
  final List<String> hashtags;
  final String source;

  /* --- PART 4: mandatory editorial ending --- */

  /// Exact required tail (e.g. `#ai #automation`); null on fixtures.
  final String? mandatoryFinalHashtags;

  /// Whether the canonical caption really ends with it (null on fixtures).
  final bool? mandatoryEndingPresent;

  bool get hasMandatoryEnding => mandatoryEndingPresent == true;

  factory ContentCaption.fromJson(Map<String, dynamic> json) => ContentCaption(
        fullText: json['fullText'] as String? ?? '',
        hashtags: (json['hashtags'] as List?)?.map((e) => e.toString()).toList() ?? const [],
        source: json['source'] as String? ?? '',
        mandatoryFinalHashtags: json['mandatoryFinalHashtags'] as String?,
        mandatoryEndingPresent: json['mandatoryEndingPresent'] as bool?,
      );
}

/* -------------------------------------------------------------------------- */
/*  PART 4 — editorial policy + image-quality reports                         */
/* -------------------------------------------------------------------------- */

/// Structured result of the mandatory editorial policy (no first-person
/// claims, disclosure present, mandatory `#ai #automation` ending, no
/// fabricated prices/discounts/benefits).
class EditorialReport {
  const EditorialReport({
    required this.source,
    required this.passed,
    required this.mandatoryFinalHashtags,
    required this.mandatoryEndingPresent,
    required this.disclosurePresent,
    required this.blocking,
    required this.warnings,
    required this.limitations,
  });

  final String source;
  final bool passed;
  final String mandatoryFinalHashtags;
  final bool mandatoryEndingPresent;
  final bool disclosurePresent;
  final List<ValidationIssueModel> blocking;
  final List<ValidationIssueModel> warnings;

  /// Honest scope statement: heuristic detection, not a human review.
  final String limitations;

  factory EditorialReport.fromJson(Map<String, dynamic> json) => EditorialReport(
        source: json['source'] as String? ?? '',
        passed: json['passed'] as bool? ?? false,
        mandatoryFinalHashtags: json['mandatoryFinalHashtags'] as String? ?? '',
        mandatoryEndingPresent: json['mandatoryEndingPresent'] as bool? ?? false,
        disclosurePresent: json['disclosurePresent'] as bool? ?? false,
        blocking: (json['blocking'] as List?)
                ?.whereType<Map<String, dynamic>>()
                .map(ValidationIssueModel.fromJson)
                .toList() ??
            const [],
        warnings: (json['warnings'] as List?)
                ?.whereType<Map<String, dynamic>>()
                .map(ValidationIssueModel.fromJson)
                .toList() ??
            const [],
        limitations: json['limitations'] as String? ?? '',
      );
}

/// A dimension that was deliberately NOT scored, with the honest reason.
class QualityDimension {
  const QualityDimension({required this.dimension, required this.reason});

  final String dimension;
  final String reason;

  factory QualityDimension.fromJson(Map<String, dynamic> json) => QualityDimension(
        dimension: json['dimension'] as String? ?? '',
        reason: json['reason'] as String? ?? '',
      );
}

/// Structural image-quality result. [automatedFidelityScore] is ALWAYS null:
/// no vision scorer exists, so a successful generation never proves the image
/// depicts the correct product.
class ImageQualityReport {
  const ImageQualityReport({
    required this.source,
    required this.passed,
    required this.automatedFidelityScore,
    required this.limitations,
    required this.notAssessed,
    required this.blocking,
  });

  final String source;
  final bool passed;

  /// Always null — never fabricated by the backend or the APK.
  final int? automatedFidelityScore;
  final String limitations;
  final List<QualityDimension> notAssessed;
  final List<ValidationIssueModel> blocking;

  factory ImageQualityReport.fromJson(Map<String, dynamic> json) => ImageQualityReport(
        source: json['source'] as String? ?? '',
        passed: json['passed'] as bool? ?? false,
        automatedFidelityScore: (json['automatedFidelityScore'] as num?)?.toInt(),
        limitations: json['limitations'] as String? ?? '',
        notAssessed: (json['notAssessed'] as List?)
                ?.whereType<Map<String, dynamic>>()
                .map(QualityDimension.fromJson)
                .toList() ??
            const [],
        blocking: (json['blocking'] as List?)
                ?.whereType<Map<String, dynamic>>()
                .map(ValidationIssueModel.fromJson)
                .toList() ??
            const [],
      );
}

class ValidationIssueModel {
  const ValidationIssueModel({required this.rule, required this.message});

  final String rule;
  final String message;

  factory ValidationIssueModel.fromJson(Map<String, dynamic> json) => ValidationIssueModel(
        rule: json['rule'] as String? ?? '',
        message: json['message'] as String? ?? '',
      );
}

class ValidationReport {
  const ValidationReport({
    required this.passed,
    required this.blocking,
    required this.warnings,
    required this.platformsChecked,
    required this.source,
  });

  final bool passed;
  final List<ValidationIssueModel> blocking;
  final List<ValidationIssueModel> warnings;
  final List<String> platformsChecked;
  final String source;

  factory ValidationReport.fromJson(Map<String, dynamic> json) => ValidationReport(
        passed: json['passed'] as bool? ?? false,
        blocking: (json['blocking'] as List?)
                ?.whereType<Map<String, dynamic>>()
                .map(ValidationIssueModel.fromJson)
                .toList() ??
            const [],
        warnings: (json['warnings'] as List?)
                ?.whereType<Map<String, dynamic>>()
                .map(ValidationIssueModel.fromJson)
                .toList() ??
            const [],
        platformsChecked: (json['platformsChecked'] as List?)
                ?.map((e) => e.toString())
                .toList() ??
            const [],
        source: json['source'] as String? ?? '',
      );
}

class PreviewPlatformStatus {
  const PreviewPlatformStatus({
    required this.enabled,
    required this.status,
    required this.url,
    required this.detail,
  });

  final bool enabled;
  final String status;
  final String? url;
  final String detail;

  factory PreviewPlatformStatus.fromJson(Map<String, dynamic> json) =>
      PreviewPlatformStatus(
        enabled: json['enabled'] as bool? ?? false,
        status: json['status'] as String? ?? '',
        url: json['url'] as String?,
        detail: json['detail'] as String? ?? '',
      );
}

class ContentPreview {
  const ContentPreview({
    required this.source,
    required this.note,
    required this.slotKey,
    required this.imageCountPolicy,
    required this.imageCount,
    required this.imageCountSource,
    required this.product,
    required this.caption,
    required this.validation,
    required this.facebook,
    required this.threads,
    this.stage,
    this.images = const [],
    this.blockers = const [],
    this.lastError,
    this.providers,
    this.publishReady = false,
    this.attempts = 0,
    this.generationRunId,
    this.updatedAt,
    this.editorial,
    this.imageQuality,
  });

  final String source;
  final String note;
  final String slotKey;
  final ImageCountPolicy imageCountPolicy;

  /// ONE count for the slot, shared by Facebook and Threads.
  final int imageCount;
  final String imageCountSource;
  final ContentProduct product;
  final ContentCaption caption;
  final ValidationReport validation;
  final PreviewPlatformStatus facebook;
  final PreviewPlatformStatus threads;

  /* --- Part 3 pipeline fields (absent on fixture payloads) --- */

  /// Pipeline stage; null for fixture payloads.
  final PipelineStage? stage;

  /// Generated image assets (empty for fixtures).
  final List<PipelineImage> images;

  /// Machine-readable reasons the slot is blocked (empty when publish-ready).
  final List<PipelineBlocker> blockers;

  /// PART 7: exact reason generation stopped on a `failed` slot (redacted).
  /// Null on fixtures and on healthy slots — never a bare "failed" with no
  /// explanation (e.g. a missing API key is spelled out here).
  final String? lastError;

  /// Honest provider summary (null for fixtures).
  final PipelineProviders? providers;

  /// True only when the REAL pipeline validated everything for publication.
  final bool publishReady;
  final int attempts;
  final String? generationRunId;
  final String? updatedAt;

  /* --- Part 4 editorial + image-quality reports (null on fixtures) --- */

  /// Structured editorial policy result (never bypassed for the schedule).
  final EditorialReport? editorial;

  /// Structural image-quality result; fidelity score is always null there.
  final ImageQualityReport? imageQuality;

  bool get isFixture => source == 'fixture';
  bool get isPipeline => source == 'pipeline';

  /// True when any provider behind this content was a mock (honesty badge).
  bool get usesMockProvider =>
      (providers?.image?.isMock ?? false) || (providers?.caption?.isMock ?? false);

  factory ContentPreview.fromJson(Map<String, dynamic> json) {
    final platforms = (json['platforms'] as Map<String, dynamic>?) ?? const {};
    return ContentPreview(
      source: json['source'] as String? ?? '',
      note: json['note'] as String? ?? '',
      slotKey: json['slotKey'] as String? ?? '',
      imageCountPolicy: ImageCountPolicy.parse(json['imageCountPolicy'] as String?),
      imageCount: (json['imageCount'] as num?)?.toInt() ?? 1,
      imageCountSource: json['imageCountSource'] as String? ?? '',
      product: ContentProduct.fromJson(
        (json['product'] as Map<String, dynamic>?) ?? const {},
      ),
      caption: ContentCaption.fromJson(
        (json['caption'] as Map<String, dynamic>?) ?? const {},
      ),
      validation: ValidationReport.fromJson(
        (json['validation'] as Map<String, dynamic>?) ?? const {},
      ),
      facebook: PreviewPlatformStatus.fromJson(
        (platforms['facebook'] as Map<String, dynamic>?) ?? const {},
      ),
      threads: PreviewPlatformStatus.fromJson(
        (platforms['threads'] as Map<String, dynamic>?) ?? const {},
      ),
      stage: json['stage'] is String
          ? PipelineStage.parse(json['stage'] as String)
          : null,
      images: (json['images'] as List?)
              ?.whereType<Map<String, dynamic>>()
              .map(PipelineImage.fromJson)
              .toList() ??
          const [],
      blockers: (json['blockers'] as List?)
              ?.whereType<Map<String, dynamic>>()
              .map(PipelineBlocker.fromJson)
              .toList() ??
          const [],
      lastError: json['lastError'] as String?,
      providers: json['providers'] is Map<String, dynamic>
          ? PipelineProviders.fromJson(json['providers'] as Map<String, dynamic>)
          : null,
      publishReady: json['publishReady'] as bool? ?? false,
      attempts: (json['attempts'] as num?)?.toInt() ?? 0,
      generationRunId: json['generationRunId'] as String?,
      updatedAt: json['updatedAt'] as String?,
      editorial: json['editorial'] is Map<String, dynamic>
          ? EditorialReport.fromJson(json['editorial'] as Map<String, dynamic>)
          : null,
      imageQuality: json['imageQuality'] is Map<String, dynamic>
          ? ImageQualityReport.fromJson(json['imageQuality'] as Map<String, dynamic>)
          : null,
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Publishing history (fixture)                                              */
/* -------------------------------------------------------------------------- */

class PlatformPublishResult {
  const PlatformPublishResult({required this.status, required this.url, required this.error});

  final String status;
  final String? url;
  final String? error;

  bool get published => status == 'published';
  bool get failed => status == 'failed';

  factory PlatformPublishResult.fromJson(Map<String, dynamic> json) => PlatformPublishResult(
        status: json['status'] as String? ?? '',
        url: json['url'] as String?,
        error: json['error'] as String?,
      );
}

class RetryStatus {
  const RetryStatus({required this.status, required this.attempts, required this.maxAttempts});

  final String status;
  final int attempts;
  final int maxAttempts;

  bool get pending => status == 'pending';
  bool get exhausted => status == 'exhausted';

  factory RetryStatus.fromJson(Map<String, dynamic> json) => RetryStatus(
        status: json['status'] as String? ?? '',
        attempts: (json['attempts'] as num?)?.toInt() ?? 0,
        maxAttempts: (json['maxAttempts'] as num?)?.toInt() ?? 0,
      );
}

class PublishRecord {
  const PublishRecord({
    required this.source,
    required this.id,
    required this.slotKey,
    required this.publishedAt,
    required this.productName,
    required this.imageCount,
    required this.facebook,
    required this.threads,
    required this.retry,
  });

  final String source;
  final String id;
  final String slotKey;
  final String publishedAt;
  final String productName;

  /// Shared by both destinations (never randomized per platform).
  final int imageCount;
  final PlatformPublishResult facebook;
  final PlatformPublishResult threads;
  final RetryStatus retry;

  bool get isFixture => source == 'fixture';

  factory PublishRecord.fromJson(Map<String, dynamic> json) => PublishRecord(
        source: json['source'] as String? ?? '',
        id: json['id'] as String? ?? '',
        slotKey: json['slotKey'] as String? ?? '',
        publishedAt: json['publishedAt'] as String? ?? '',
        productName: json['productName'] as String? ?? '',
        imageCount: (json['imageCount'] as num?)?.toInt() ?? 0,
        facebook: PlatformPublishResult.fromJson(
          (json['facebook'] as Map<String, dynamic>?) ?? const {},
        ),
        threads: PlatformPublishResult.fromJson(
          (json['threads'] as Map<String, dynamic>?) ?? const {},
        ),
        retry: RetryStatus.fromJson(
          (json['retry'] as Map<String, dynamic>?) ?? const {},
        ),
      );
}

/* -------------------------------------------------------------------------- */
/*  Integration health                                                        */
/* -------------------------------------------------------------------------- */

enum IntegrationHealth {
  connected('connected', 'Connected'),
  blocked('blocked', 'Blocked'),
  notTested('not_tested', 'Not tested'),
  disconnected('disconnected', 'Disconnected');

  const IntegrationHealth(this.wireValue, this.label);
  final String wireValue;
  final String label;

  static IntegrationHealth parse(String? raw) {
    for (final value in IntegrationHealth.values) {
      if (value.wireValue == raw) return value;
    }
    return IntegrationHealth.disconnected;
  }
}

class IntegrationHealthEntry {
  const IntegrationHealthEntry({
    required this.service,
    required this.configured,
    required this.mode,
    required this.detail,
    required this.health,
    required this.healthDetail,
  });

  final String service;
  final bool configured;
  final String mode;
  final String detail;
  final IntegrationHealth health;
  final String healthDetail;

  /// Localisation-free display name for the service key.
  String get displayName => switch (service) {
        'facebook_page' => 'Facebook Page',
        'threads' => 'Threads',
        'telegram' => 'Telegram',
        's3_storage' => 'Object storage (S3)',
        'ai_image' => 'AI image generation',
        'ai_text' => 'AI caption generation',
        'shopee_feed' => 'Shopee product feed',
        'postgresql' => 'PostgreSQL',
        _ => service,
      };

  factory IntegrationHealthEntry.fromJson(Map<String, dynamic> json) =>
      IntegrationHealthEntry(
        service: json['service'] as String? ?? '',
        configured: json['configured'] as bool? ?? false,
        mode: json['mode'] as String? ?? '',
        detail: json['detail'] as String? ?? '',
        health: IntegrationHealth.parse(json['health'] as String?),
        healthDetail: json['healthDetail'] as String? ?? '',
      );
}

/* -------------------------------------------------------------------------- */
/*  Product catalog (Part 3)                                                  */
/* -------------------------------------------------------------------------- */

/// A category derived from the ACTUAL imported catalog (never hardcoded).
class CatalogCategory {
  const CatalogCategory({
    required this.id,
    required this.name,
    required this.productCount,
    required this.eligibleProductCount,
  });

  final String id;
  final String name;
  final int productCount;
  final int eligibleProductCount;

  factory CatalogCategory.fromJson(Map<String, dynamic> json) => CatalogCategory(
        id: json['id'] as String? ?? '',
        name: json['name'] as String? ?? '',
        productCount: (json['productCount'] as num?)?.toInt() ?? 0,
        eligibleProductCount: (json['eligibleProductCount'] as num?)?.toInt() ?? 0,
      );
}

class CatalogCategoriesPayload {
  const CatalogCategoriesPayload({
    required this.categories,
    required this.count,
    required this.total,
    required this.note,
  });

  final List<CatalogCategory> categories;
  final int count;
  final int total;
  final String note;

  /// True when nothing has been imported yet (empty-catalog UX state).
  bool get isEmpty => categories.isEmpty;

  factory CatalogCategoriesPayload.fromJson(Map<String, dynamic> json) =>
      CatalogCategoriesPayload(
        categories: (json['categories'] as List?)
                ?.whereType<Map<String, dynamic>>()
                .map(CatalogCategory.fromJson)
                .toList() ??
            const [],
        count: (json['count'] as num?)?.toInt() ?? 0,
        total: (json['total'] as num?)?.toInt() ?? 0,
        note: json['note'] as String? ?? '',
      );
}

/* -------------------------------------------------------------------------- */
/*  Content pipeline (Part 3)                                                 */
/* -------------------------------------------------------------------------- */

/// One generated image asset, as reported by the REAL pipeline.
class PipelineImage {
  const PipelineImage({
    required this.position,
    required this.view,
    required this.publicUrl,
    required this.width,
    required this.height,
    required this.sizeBytes,
    required this.checksumSha256,
    required this.provider,
    required this.providerKind,
    required this.model,
    required this.promptVersion,
    required this.referenceImageUrl,
  });

  final int position;
  final String view;
  final String publicUrl;
  final int width;
  final int height;
  final int sizeBytes;
  final String checksumSha256;
  final String provider;

  /// `"mock"` or `"live"` — the APK must never present a mock as a live run.
  final String providerKind;
  final String model;
  final String promptVersion;
  final String? referenceImageUrl;

  bool get isMock => providerKind == 'mock';

  factory PipelineImage.fromJson(Map<String, dynamic> json) => PipelineImage(
        position: (json['position'] as num?)?.toInt() ?? 0,
        view: json['view'] as String? ?? '',
        publicUrl: json['publicUrl'] as String? ?? '',
        width: (json['width'] as num?)?.toInt() ?? 0,
        height: (json['height'] as num?)?.toInt() ?? 0,
        sizeBytes: (json['sizeBytes'] as num?)?.toInt() ?? 0,
        checksumSha256: json['checksumSha256'] as String? ?? '',
        provider: json['provider'] as String? ?? '',
        providerKind: json['providerKind'] as String? ?? '',
        model: json['model'] as String? ?? '',
        promptVersion: json['promptVersion'] as String? ?? '',
        referenceImageUrl: json['referenceImageUrl'] as String?,
      );
}

class PipelineBlocker {
  const PipelineBlocker({required this.code, required this.message});

  final String code;
  final String message;

  factory PipelineBlocker.fromJson(Map<String, dynamic> json) => PipelineBlocker(
        code: json['code'] as String? ?? '',
        message: json['message'] as String? ?? '',
      );
}

/// Honest provider summary: which concrete generator produced the content.
class PipelineProvider {
  const PipelineProvider({required this.name, required this.kind});

  final String name;
  final String kind;

  bool get isMock => kind == 'mock';

  factory PipelineProvider.fromJson(Map<String, dynamic> json) => PipelineProvider(
        name: json['name'] as String? ?? '',
        kind: json['kind'] as String? ?? '',
      );
}

class PipelineProviders {
  const PipelineProviders({required this.image, required this.caption});

  final PipelineProvider? image;
  final PipelineProvider? caption;

  factory PipelineProviders.fromJson(Map<String, dynamic> json) =>
      PipelineProviders(
        image: json['image'] is Map<String, dynamic>
            ? PipelineProvider.fromJson(json['image'] as Map<String, dynamic>)
            : null,
        caption: json['caption'] is Map<String, dynamic>
            ? PipelineProvider.fromJson(json['caption'] as Map<String, dynamic>)
            : null,
      );
}

/// Stage of the backend content pipeline for a slot.
enum PipelineStage {
  reserved('reserved'),
  generatingImages('generating_images'),
  imagesReady('images_ready'),
  generatingCaptions('generating_captions'),
  captionsReady('captions_ready'),
  validated('validated'),
  publishReady('publish_ready'),
  blocked('blocked'),
  failed('failed');

  const PipelineStage(this.wireValue);
  final String wireValue;

  static PipelineStage parse(String? raw) {
    for (final value in PipelineStage.values) {
      if (value.wireValue == raw) return value;
    }
    return PipelineStage.reserved;
  }

  bool get isTerminal => this == publishReady || this == blocked || this == failed;
}
