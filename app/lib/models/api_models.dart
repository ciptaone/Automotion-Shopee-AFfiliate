/// Data models mirroring the backend's JSON contracts (Part 1).
///
/// These are hand-written rather than code-generated to keep the APK dependency
/// surface minimal and auditable. Every field is nullable-safe so a newer
/// backend cannot crash an older APK.
library;

/* -------------------------------------------------------------------------- */
/*  Health                                                                    */
/* -------------------------------------------------------------------------- */

class HealthReport {
  final String status;
  final String version;
  final int part;
  final int uptimeSeconds;
  final String timestamp;
  final List<String> degradedReasons;
  final DatabaseStatus database;
  final SchedulerStatus scheduler;
  final List<IntegrationStatus> integrations;

  const HealthReport({
    required this.status,
    required this.version,
    required this.part,
    required this.uptimeSeconds,
    required this.timestamp,
    required this.degradedReasons,
    required this.database,
    required this.scheduler,
    required this.integrations,
  });

  factory HealthReport.fromJson(Map<String, dynamic> json) {
    return HealthReport(
      status: json['status'] as String? ?? 'unknown',
      version: json['version'] as String? ?? '',
      part: (json['part'] as num?)?.toInt() ?? 0,
      uptimeSeconds: (json['uptimeSeconds'] as num?)?.toInt() ?? 0,
      timestamp: json['timestamp'] as String? ?? '',
      degradedReasons: _stringList(json['degradedReasons']),
      database: DatabaseStatus.fromJson(
        (json['database'] as Map<String, dynamic>?) ?? const {},
      ),
      scheduler: SchedulerStatus.fromJson(
        (json['scheduler'] as Map<String, dynamic>?) ?? const {},
      ),
      integrations: _mapList(json['integrations'], IntegrationStatus.fromJson),
    );
  }
}

class DatabaseStatus {
  final bool configured;
  final bool healthy;
  final String detail;

  const DatabaseStatus({
    required this.configured,
    required this.healthy,
    required this.detail,
  });

  factory DatabaseStatus.fromJson(Map<String, dynamic> json) => DatabaseStatus(
        configured: json['configured'] as bool? ?? false,
        healthy: json['healthy'] as bool? ?? false,
        detail: json['detail'] as String? ?? '',
      );
}

class SchedulerStatus {
  final bool enabled;
  final String mode;
  final String timezone;
  final int intervalMinutes;
  final int maxSlotsPerDay;
  final String today;
  final int slotsToday;
  final NextSlot? nextSlot;
  final String message;

  const SchedulerStatus({
    required this.enabled,
    required this.mode,
    required this.timezone,
    required this.intervalMinutes,
    required this.maxSlotsPerDay,
    required this.today,
    required this.slotsToday,
    required this.nextSlot,
    required this.message,
  });

  factory SchedulerStatus.fromJson(Map<String, dynamic> json) => SchedulerStatus(
        enabled: json['enabled'] as bool? ?? false,
        mode: json['mode'] as String? ?? '',
        timezone: json['timezone'] as String? ?? '',
        intervalMinutes: (json['intervalMinutes'] as num?)?.toInt() ?? 0,
        maxSlotsPerDay: (json['maxSlotsPerDay'] as num?)?.toInt() ?? 0,
        today: json['today'] as String? ?? '',
        slotsToday: (json['slotsToday'] as num?)?.toInt() ?? 0,
        nextSlot: json['nextSlot'] is Map<String, dynamic>
            ? NextSlot.fromJson(json['nextSlot'] as Map<String, dynamic>)
            : null,
        message: json['message'] as String? ?? '',
      );
}

class NextSlot {
  final String key;
  final String scheduledFor;

  const NextSlot({required this.key, required this.scheduledFor});

  factory NextSlot.fromJson(Map<String, dynamic> json) => NextSlot(
        key: json['key'] as String? ?? '',
        scheduledFor: json['scheduledFor'] as String? ?? '',
      );
}

/* -------------------------------------------------------------------------- */
/*  Integrations                                                              */
/* -------------------------------------------------------------------------- */

class IntegrationStatus {
  final String service;
  final bool configured;
  final String mode;
  final String detail;

  const IntegrationStatus({
    required this.service,
    required this.configured,
    required this.mode,
    required this.detail,
  });

  factory IntegrationStatus.fromJson(Map<String, dynamic> json) => IntegrationStatus(
        service: json['service'] as String? ?? '',
        configured: json['configured'] as bool? ?? false,
        mode: json['mode'] as String? ?? '',
        detail: json['detail'] as String? ?? '',
      );
}

/* -------------------------------------------------------------------------- */
/*  Auth                                                                      */
/* -------------------------------------------------------------------------- */

class TokenResponse {
  final String accessToken;
  final String tokenType;
  final int expiresIn;
  final List<String> scope;

  const TokenResponse({
    required this.accessToken,
    required this.tokenType,
    required this.expiresIn,
    required this.scope,
  });

  factory TokenResponse.fromJson(Map<String, dynamic> json) => TokenResponse(
        accessToken: json['accessToken'] as String? ?? '',
        tokenType: json['tokenType'] as String? ?? 'Bearer',
        expiresIn: (json['expiresIn'] as num?)?.toInt() ?? 0,
        scope: _stringList(json['scope']),
      );
}

/* -------------------------------------------------------------------------- */
/*  Scheduler & queue                                                         */
/* -------------------------------------------------------------------------- */

class JobRecord {
  final String id;
  final String kind;
  final String status;
  final String uniqueKey;
  final String scheduledFor;
  final int attempts;
  final int maxAttempts;
  final String? lastError;

  const JobRecord({
    required this.id,
    required this.kind,
    required this.status,
    required this.uniqueKey,
    required this.scheduledFor,
    required this.attempts,
    required this.maxAttempts,
    this.lastError,
  });

  factory JobRecord.fromJson(Map<String, dynamic> json) => JobRecord(
        id: json['id'] as String? ?? '',
        kind: json['kind'] as String? ?? '',
        status: json['status'] as String? ?? '',
        uniqueKey: json['uniqueKey'] as String? ?? '',
        scheduledFor: json['scheduledFor'] as String? ?? '',
        attempts: (json['attempts'] as num?)?.toInt() ?? 0,
        maxAttempts: (json['maxAttempts'] as num?)?.toInt() ?? 0,
        lastError: json['lastError'] as String?,
      );
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

List<String> _stringList(dynamic value) {
  if (value is List) {
    return value.map((e) => e.toString()).toList();
  }
  return const [];
}

List<T> _mapList<T>(
  dynamic value,
  T Function(Map<String, dynamic>) fromJson,
) {
  if (value is List) {
    return value
        .whereType<Map<String, dynamic>>()
        .map(fromJson)
        .toList();
  }
  return const [];
}
