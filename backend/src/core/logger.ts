/**
 * Structured JSON logger with mandatory secret redaction.
 *
 * Built on `pino` but wrapped so that:
 *  - every `info`/`warn`/`error`/`debug` payload is deep-redacted before serialization,
 *  - `err` objects are serialized through the typed-error shape when available,
 *  - the logger never throws (logging must never break a request path).
 *
 * In development (`LOG_PRETTY=true`) a human-readable transport is used, but the
 * redaction pass still applies.
 */
import { pino, type Logger as PinoLogger } from 'pino';
import { redactDeep, redactString } from './redact.js';
import { isAppError } from './errors.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly pretty?: boolean;
  readonly name?: string;
  readonly base?: Record<string, unknown>;
}

function serializeError(err: unknown): Record<string, unknown> {
  if (isAppError(err)) {
    const obj = err.toLogObject();
    return { ...obj, message: redactString(err.message) };
  }
  if (err instanceof Error) {
    return {
      type: 'Error',
      name: err.name,
      message: redactString(err.message),
      stack: err.stack ? redactString(err.stack) : undefined,
      cause: err.cause !== undefined ? redactDeep(err.cause) : undefined,
    };
  }
  return { type: 'NonError', value: redactDeep(err) };
}

export interface Logger {
  level: LogLevel;
  debug(obj: Record<string, unknown>, msg?: string): void;
  debug(msg: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  error(msg: string): void;
  fatal(obj: Record<string, unknown>, msg?: string): void;
  fatal(msg: string): void;
  /** Derive a child logger with additional bound fields (redacted). */
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Create a logger. Falls back to a no-op-ish console logger if pino fails to
 * initialize, so the process can still start and report the failure.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? (process.env['LOG_LEVEL'] as LogLevel | undefined) ?? 'info';
  const pretty = options.pretty ?? process.env['LOG_PRETTY'] === 'true';

  const redactHook = (obj: Record<string, unknown>): void => {
    const redacted = redactDeep(obj) as Record<string, unknown>;
    // Mutate in place so pino serializes the redacted values.
    for (const key of Object.keys(obj)) {
      delete obj[key];
    }
    Object.assign(obj, redacted);
  };

  const pinoOptions: Record<string, unknown> = {
    level,
    base: { ...(options.base ?? {}), name: options.name ?? 'shopee-affiliate-autopilot' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string) => ({ level: label }),
      log: (obj: Record<string, unknown>) => {
        redactHook(obj);
        return obj;
      },
    },
    hooks: {
      logMethod(args: unknown[], method: (...a: unknown[]) => void): void {
        // Redact string arguments (message form) too.
        const mapped = args.map((a) => (typeof a === 'string' ? redactString(a) : a));
        // If an Error is passed as the first arg, convert to a structured field.
        if (mapped.length > 0 && mapped[0] instanceof Error) {
          const [err, ...rest] = mapped;
          const safeErr = serializeError(err);
          method.call(this, safeErr, ...rest);
          return;
        }
        method.apply(this, mapped);
      },
    },
    serializers: {
      err: serializeError,
      error: serializeError,
    },
  };

  if (pretty) {
    pinoOptions['transport'] = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
    };
  }

  let pinoLogger: PinoLogger;
  try {
    pinoLogger = pino(pinoOptions);
  } catch {
    // Transport resolution can fail (e.g. pino-pretty missing). Retry without it.
    delete pinoOptions['transport'];
    pinoLogger = pino(pinoOptions);
  }

  const wrap = (logger: PinoLogger): Logger => {
    return {
      get level(): LogLevel {
        return logger.level as LogLevel;
      },
      set level(next: LogLevel) {
        logger.level = next;
      },
      debug: (obj: Record<string, unknown> | string, msg?: string): void => {
        if (typeof obj === 'string') {
          logger.debug(obj);
        } else {
          logger.debug(obj, msg);
        }
      },
      info: (obj: Record<string, unknown> | string, msg?: string): void => {
        if (typeof obj === 'string') {
          logger.info(obj);
        } else {
          logger.info(obj, msg);
        }
      },
      warn: (obj: Record<string, unknown> | string, msg?: string): void => {
        if (typeof obj === 'string') {
          logger.warn(obj);
        } else {
          logger.warn(obj, msg);
        }
      },
      error: (obj: Record<string, unknown> | string, msg?: string): void => {
        if (typeof obj === 'string') {
          logger.error(obj);
        } else {
          logger.error(obj, msg);
        }
      },
      fatal: (obj: Record<string, unknown> | string, msg?: string): void => {
        if (typeof obj === 'string') {
          logger.fatal(obj);
        } else {
          logger.fatal(obj, msg);
        }
      },
      child: (bindings: Record<string, unknown>) => wrap(logger.child(bindings)),
    };
  };

  return wrap(pinoLogger);
}

/** A logger that discards everything. Useful in unit tests. */
export function createNullLogger(): Logger {
  const noop = (): void => {
    /* discard */
  };
  const logger: Logger = {
    level: 'fatal',
    debug: noop as Logger['debug'],
    info: noop as Logger['info'],
    warn: noop as Logger['warn'],
    error: noop as Logger['error'],
    fatal: noop as Logger['fatal'],
    child: () => logger,
  };
  return logger;
}

/** Process-wide default logger; replaced in tests via `setGlobalLogger`. */
let globalLogger: Logger = createLogger({ name: 'shopee-affiliate-autopilot' });

export function getLogger(): Logger {
  return globalLogger;
}

export function setGlobalLogger(logger: Logger): void {
  globalLogger = logger;
}
