/// PART 8 §2-§5 — typed views over GET /v1/ops/health.
///
/// The Ops dashboard renders these; every field mirrors the backend contract
/// exactly (the backend never sends secrets, so nothing here can leak one).
library;

/// Backend health vocabulary (locked set — see backend `component-health.ts`).
const kHealthStatuses = <String>{
  'healthy',
  'degraded',
  'blocked',
  'unavailable',
  'not_configured',
  'not_tested',
  'disabled',
};

/// One component row of the health report.
class OpsComponent {
  const OpsComponent({
    required this.key,
    required this.displayName,
    required this.status,
    required this.code,
    required this.message,
    required this.criticality,
    required this.checkedAt,
    this.data = const {},
  });

  final String key;
  final String displayName;
  final String status;
  final String code;
  final String message;
  final String criticality;
  final String checkedAt;
  final Map<String, dynamic> data;

  factory OpsComponent.fromJson(Map<String, dynamic> json) => OpsComponent(
        key: json['key'] as String? ?? '',
        displayName: json['displayName'] as String? ?? '',
        status: json['status'] as String? ?? 'not_tested',
        code: json['code'] as String? ?? '',
        message: json['message'] as String? ?? '',
        criticality: json['criticality'] as String? ?? 'operational',
        checkedAt: json['checkedAt'] as String? ?? '',
        data: json['data'] is Map<String, dynamic>
            ? json['data'] as Map<String, dynamic>
            : const {},
      );
}

/// Scheduler diagnostics for the Jakarta calendar day.
class OpsSchedulerDiagnostics {
  const OpsSchedulerDiagnostics({
    required this.enabled,
    required this.mode,
    required this.timezone,
    required this.automationState,
    required this.dailyPostTarget,
    required this.slotsToday,
    required this.today,
    this.nextSlotAt,
    this.lastTickAt,
    this.lastSuccessfulTickAt,
    this.lastTickSkipped,
    this.lastTickExecuted,
  });

  final bool enabled;
  final String mode;
  final String timezone;
  final String automationState;
  final int dailyPostTarget;
  final int slotsToday;
  final String today;
  final String? nextSlotAt;
  final String? lastTickAt;
  final String? lastSuccessfulTickAt;
  final int? lastTickSkipped;
  final int? lastTickExecuted;

  factory OpsSchedulerDiagnostics.fromJson(Map<String, dynamic> json) =>
      OpsSchedulerDiagnostics(
        enabled: json['enabled'] as bool? ?? false,
        mode: json['mode'] as String? ?? '',
        timezone: json['timezone'] as String? ?? '',
        automationState: json['automationState'] as String? ?? '',
        dailyPostTarget: (json['dailyPostTarget'] as num?)?.toInt() ?? 0,
        slotsToday: (json['slotsToday'] as num?)?.toInt() ?? 0,
        today: json['today'] as String? ?? '',
        nextSlotAt: json['nextSlotAt'] as String?,
        lastTickAt: json['lastTickAt'] as String?,
        lastSuccessfulTickAt: json['lastSuccessfulTickAt'] as String?,
        lastTickSkipped: (json['lastTickSkipped'] as num?)?.toInt(),
        lastTickExecuted: (json['lastTickExecuted'] as num?)?.toInt(),
      );
}

/// Queue counters/ages — low-cardinality by contract (no job ids, no payloads).
class OpsQueueStats {
  const OpsQueueStats({
    required this.pending,
    required this.running,
    required this.succeeded,
    required this.failed,
    required this.cancelled,
    required this.retrying,
    this.oldestPendingAt,
    this.oldestPendingAgeMs,
    required this.expiredLeases,
  });

  final int pending;
  final int running;
  final int succeeded;
  final int failed;
  final int cancelled;
  final int retrying;
  final String? oldestPendingAt;
  final int? oldestPendingAgeMs;
  final int expiredLeases;

  factory OpsQueueStats.fromJson(Map<String, dynamic> json) => OpsQueueStats(
        pending: (json['pending'] as num?)?.toInt() ?? 0,
        running: (json['running'] as num?)?.toInt() ?? 0,
        succeeded: (json['succeeded'] as num?)?.toInt() ?? 0,
        failed: (json['failed'] as num?)?.toInt() ?? 0,
        cancelled: (json['cancelled'] as num?)?.toInt() ?? 0,
        retrying: (json['retrying'] as num?)?.toInt() ?? 0,
        oldestPendingAt: json['oldestPendingAt'] as String?,
        oldestPendingAgeMs: (json['oldestPendingAgeMs'] as num?)?.toInt(),
        expiredLeases: (json['expiredLeases'] as num?)?.toInt() ?? 0,
      );
}

/// A persisted ops event (sanitized + bounded by the backend).
class OpsEvent {
  const OpsEvent({
    required this.fingerprint,
    required this.kind,
    required this.severity,
    required this.title,
    this.detail,
    required this.occurrences,
    required this.lastSeenAt,
    required this.lastDeliveryStatus,
    this.lastErrorCode,
    this.lastMessageId,
    this.lastNotifiedAt,
  });

  final String fingerprint;
  final String kind;
  final String severity;
  final String title;
  final String? detail;
  final int occurrences;
  final String lastSeenAt;
  final String lastDeliveryStatus;
  final String? lastErrorCode;
  final String? lastMessageId;
  final String? lastNotifiedAt;

  factory OpsEvent.fromJson(Map<String, dynamic> json) => OpsEvent(
        fingerprint: json['fingerprint'] as String? ?? '',
        kind: json['kind'] as String? ?? '',
        severity: json['severity'] as String? ?? 'info',
        title: json['title'] as String? ?? '',
        detail: json['detail'] as String?,
        occurrences: (json['occurrences'] as num?)?.toInt() ?? 1,
        lastSeenAt: json['lastSeenAt'] as String? ?? '',
        lastDeliveryStatus: json['lastDeliveryStatus'] as String? ?? 'not_sent',
        lastErrorCode: json['lastErrorCode'] as String?,
        lastMessageId: json['lastMessageId'] as String?,
        lastNotifiedAt: json['lastNotifiedAt'] as String?,
      );
}

/// Full GET /v1/ops/health payload.
class OpsHealthReport {
  const OpsHealthReport({
    required this.overall,
    required this.ready,
    required this.blockers,
    required this.components,
    required this.checkedAt,
    required this.uptimeSeconds,
    required this.persistenceBackend,
    required this.scheduler,
    this.queue,
    required this.recentEvents,
  });

  final String overall;
  final bool ready;
  final List<String> blockers;
  final List<OpsComponent> components;
  final String checkedAt;
  final int uptimeSeconds;
  final String persistenceBackend;
  final OpsSchedulerDiagnostics scheduler;
  final OpsQueueStats? queue;
  final List<OpsEvent> recentEvents;

  /// The publishing gate component — always present, always disabled-by-design.
  OpsComponent? get publishingGate {
    for (final component in components) {
      if (component.key == 'publishing_gate') return component;
    }
    return null;
  }

  factory OpsHealthReport.fromJson(Map<String, dynamic> json) =>
      OpsHealthReport(
        overall: json['overall'] as String? ?? 'not_tested',
        ready: json['ready'] as bool? ?? false,
        blockers: (json['blockers'] as List?)
                ?.map((e) => e.toString())
                .toList() ??
            const [],
        components: (json['components'] as List?)
                ?.whereType<Map<String, dynamic>>()
                .map(OpsComponent.fromJson)
                .toList() ??
            const [],
        checkedAt: json['checkedAt'] as String? ?? '',
        uptimeSeconds: (json['uptimeSeconds'] as num?)?.toInt() ?? 0,
        persistenceBackend: json['persistenceBackend'] as String? ?? '',
        scheduler: OpsSchedulerDiagnostics.fromJson(
            json['scheduler'] is Map<String, dynamic>
                ? json['scheduler'] as Map<String, dynamic>
                : const {}),
        queue: json['queue'] is Map<String, dynamic>
            ? OpsQueueStats.fromJson(json['queue'] as Map<String, dynamic>)
            : null,
        recentEvents: (json['recentEvents'] as List?)
                ?.whereType<Map<String, dynamic>>()
                .map(OpsEvent.fromJson)
                .toList() ??
            const [],
      );
}
