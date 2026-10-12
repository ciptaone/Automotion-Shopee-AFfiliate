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

class AutomationSettings {
  const AutomationSettings({
    required this.intervalMinutes,
    required this.maxSlotsPerDay,
    required this.facebookEnabled,
    required this.threadsEnabled,
    required this.imageCountPolicy,
    required this.telegramNotificationsEnabled,
    required this.automationState,
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
  );

  final int intervalMinutes;
  final int maxSlotsPerDay;
  final bool facebookEnabled;
  final bool threadsEnabled;
  final ImageCountPolicy imageCountPolicy;
  final bool telegramNotificationsEnabled;
  final AutomationState automationState;

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
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'intervalMinutes': intervalMinutes,
        'maxSlotsPerDay': maxSlotsPerDay,
        'facebookEnabled': facebookEnabled,
        'threadsEnabled': threadsEnabled,
        'imageCountPolicy': imageCountPolicy.wireValue,
        'telegramNotificationsEnabled': telegramNotificationsEnabled,
        'automationState': automationState.wireValue,
      };

  AutomationSettings copyWith({
    int? intervalMinutes,
    int? maxSlotsPerDay,
    bool? facebookEnabled,
    bool? threadsEnabled,
    ImageCountPolicy? imageCountPolicy,
    bool? telegramNotificationsEnabled,
    AutomationState? automationState,
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
      );

  /// Client-side mirror of the backend's cross-field rule.
  String? get scheduleIssue {
    if (intervalMinutes * maxSlotsPerDay > 24 * 60) {
      return '$maxSlotsPerDay slots every $intervalMinutes minutes exceed one 24-hour day.';
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
  });

  final int minIntervalMinutes;
  final int maxIntervalMinutes;
  final int maxSlotsPerDay;
  final List<String> imageCountPolicies;

  factory SettingsConstraints.fromJson(Map<String, dynamic> json) =>
      SettingsConstraints(
        minIntervalMinutes: (json['minIntervalMinutes'] as num?)?.toInt() ?? 15,
        maxIntervalMinutes: (json['maxIntervalMinutes'] as num?)?.toInt() ?? 720,
        maxSlotsPerDay: (json['maxSlotsPerDay'] as num?)?.toInt() ?? 24,
        imageCountPolicies: (json['imageCountPolicies'] as List?)
                ?.map((e) => e.toString())
                .toList() ??
            const [],
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
  const ContentProduct({required this.name, required this.affiliateUrl, required this.source});

  final String name;
  final String affiliateUrl;

  /// `fixture` until the real pipeline exists.
  final String source;

  factory ContentProduct.fromJson(Map<String, dynamic> json) => ContentProduct(
        name: json['name'] as String? ?? '',
        affiliateUrl: json['affiliateUrl'] as String? ?? '',
        source: json['source'] as String? ?? '',
      );
}

class ContentCaption {
  const ContentCaption({required this.fullText, required this.hashtags, required this.source});

  final String fullText;
  final List<String> hashtags;
  final String source;

  factory ContentCaption.fromJson(Map<String, dynamic> json) => ContentCaption(
        fullText: json['fullText'] as String? ?? '',
        hashtags: (json['hashtags'] as List?)?.map((e) => e.toString()).toList() ?? const [],
        source: json['source'] as String? ?? '',
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

  bool get isFixture => source == 'fixture';

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
