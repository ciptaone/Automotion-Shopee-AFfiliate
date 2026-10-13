/**
 * Provider configuration contracts (Part 6).
 *
 * These types describe WHAT a configured provider is — never how to call it.
 * Concrete behaviour lives in `src/providers/adapters.ts`, which is the ONLY
 * module allowed to know adapter-specific request formats. Everything else
 * (service, router, HTTP layer, dashboard) works with the explicit capability
 * contract declared here, so a text-only endpoint can never be handed an image
 * job just because its URL happens to be "OpenAI-compatible".
 *
 * Secrets are deliberately NOT part of `ProviderConfig`: configuration and
 * credentials are stored separately (see `src/secrets/secret-store.ts`), and no
 * code path ever returns a stored secret to a client.
 */
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  Adapter types + capability contract                                       */
/* -------------------------------------------------------------------------- */

/**
 * Supported adapter types. Each maps to ONE request/response translation in
 * `adapters.ts`; adding a provider format means adding an adapter here, not
 * sprinkling provider-name conditionals through the app.
 */
export const ADAPTER_TYPES = ['openai_chat_completions', 'openai_images', 'ollama_chat'] as const;
export type AdapterType = (typeof ADAPTER_TYPES)[number];

/** Which generation tasks a configuration may be selected for. */
export const PROVIDER_TASKS = ['text', 'image'] as const;
export type ProviderTask = (typeof PROVIDER_TASKS)[number];

/** Explicit, verifiable capabilities. Declared by the adapter, optionally narrowed. */
export const CAPABILITY_KEYS = [
  'text_generation',
  'image_generation',
  'image_reference_input',
  'image_editing',
  'structured_output',
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export interface CapabilityDeclaration {
  readonly text_generation: boolean;
  readonly image_generation: boolean;
  readonly image_reference_input: boolean;
  readonly image_editing: boolean;
  readonly structured_output: boolean;
}

/**
 * Readiness vocabulary (Part 6 §5). A capability is only `ready` after it was
 * actually tested (or the adapter contract makes it structurally impossible to
 * be wrong AND the operator ran a connection test — see `provider-service.ts`).
 */
export const CAPABILITY_STATUSES = [
  'not_configured',
  'configuration_invalid',
  'authentication_failed',
  'ready',
  'capability_unsupported',
  'temporarily_unavailable',
  'rate_limited',
  'test_failed',
] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/** Probed dimensions — kept separate on purpose (§5: never conflate them). */
export const READINESS_KEYS = [
  'configuration',
  'authentication',
  'text_generation',
  'image_generation',
  'image_reference_input',
  'image_editing',
  'structured_output',
] as const;
export type ReadinessKey = (typeof READINESS_KEYS)[number];

export interface CapabilityProbe {
  readonly status: CapabilityStatus;
  /** ISO timestamp of the last real test, null when never tested. */
  readonly testedAt: string | null;
  /** Sanitized, single-line detail (never contains a credential or raw body). */
  readonly detail: string;
  /** Provider-returned request id when one was actually reported (never invented). */
  readonly requestId: string | null;
}

export function probeOf(status: CapabilityStatus, detail: string): CapabilityProbe {
  return { status, testedAt: null, detail, requestId: null };
}

export type ProviderReadiness = Partial<Record<ReadinessKey, CapabilityProbe>>;

/* -------------------------------------------------------------------------- */
/*  Authentication                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `none`   — self-hosted endpoints without auth.
 * `bearer` — `Authorization: Bearer <secret>` (OpenAI-compatible, OpenRouter…).
 * `header` — a custom header name carrying the secret (`x-api-key`, …).
 *
 * The secret VALUE is never part of the config document; only this declaration.
 */
export const AUTH_TYPES = ['none', 'bearer', 'header'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

export interface AuthConfig {
  readonly type: AuthType;
  /** Required (and only valid) when `type === 'header'`. */
  readonly headerName?: string;
}

/* -------------------------------------------------------------------------- */
/*  Provider configuration                                                    */
/* -------------------------------------------------------------------------- */

export interface ProviderConfig {
  /** Stable id (UUID) — survives renames; used for secrets + selection. */
  readonly id: string;
  /** Machine name/slug, unique in the workspace. */
  readonly name: string;
  /** Human display name shown in the dashboard. */
  readonly displayName: string;
  readonly adapterType: AdapterType;
  /** API base URL. Validated by `endpoint-policy.ts` before it is ever fetched. */
  readonly baseUrl: string;
  /** Model identifier sent to the provider (free-form, provider-specific). */
  readonly model: string;
  readonly auth: AuthConfig;
  /**
   * Non-secret static headers (e.g. `HTTP-Referer`, `X-Title`). Header names
   * that look like credentials are rejected at validation time — secrets go
   * through the secret store, not here.
   */
  readonly extraHeaders: Readonly<Record<string, string>>;
  /** Adapter-specific parameters (temperature, size, num_images…). */
  readonly params: Readonly<Record<string, unknown>>;
  /** Per-request timeout in ms (bounded 1s..120s). */
  readonly timeoutMs: number;
  /** Bounded retries for transient failures (0..3). */
  readonly maxRetries: number;
  readonly enabled: boolean;
  /**
   * Capability narrowing: a provider may DISABLE a capability its adapter
   * declares, but can never enable one the adapter does not support.
   */
  readonly capabilityOverrides: Partial<CapabilityDeclaration>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What the workspace persisted (providers + independent task selections). */
export interface ProviderWorkspace {
  readonly providers: readonly ProviderConfig[];
  /** Selected provider for caption/text generation (null = env default). */
  readonly textProviderId: string | null;
  /** Selected provider for image generation (null = env default). */
  readonly imageProviderId: string | null;
  readonly readiness: Readonly<Record<string, ProviderReadiness>>;
  readonly updatedAt: string;
}

export const EMPTY_WORKSPACE: ProviderWorkspace = {
  providers: [],
  textProviderId: null,
  imageProviderId: null,
  readiness: {},
  updatedAt: new Date(0).toISOString(),
};

/* -------------------------------------------------------------------------- */
/*  Validation schemas                                                        */
/* -------------------------------------------------------------------------- */

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** Header names that must never be user-set static headers (they carry secrets). */
const RESERVED_HEADER_PATTERN =
  /^(authorization|cookie|set-cookie|x-api-key|api-key|proxy-authorization|x-auth-token)$/i;

export const MAX_PROVIDER_PARAMS_BYTES = 8 * 1024;

const authSchema = z
  .object({
    type: z.enum(AUTH_TYPES),
    headerName: z
      .string()
      .trim()
      .regex(HEADER_NAME, 'headerName must be a valid HTTP header name')
      .max(64)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'header' && !value.headerName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['headerName'],
        message: 'auth.type "header" requires headerName (e.g. "x-api-key").',
      });
    }
    if (value.type !== 'header' && value.headerName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['headerName'],
        message: 'headerName is only valid when auth.type is "header".',
      });
    }
  });

/** Provider create/update payload (id/timestamps are assigned by the service). */
export const providerInputSchema = z
  .object({
    name: z.string().trim().toLowerCase().regex(SLUG, 'name must be a lowercase slug (a-z, 0-9, "-", "_")'),
    displayName: z.string().trim().min(1).max(80),
    adapterType: z.enum(ADAPTER_TYPES),
    baseUrl: z.string().trim().min(1).max(2048),
    model: z.string().trim().min(1).max(200),
    auth: authSchema,
    extraHeaders: z
      .record(
        z.string().regex(HEADER_NAME, 'invalid header name'),
        z.string().max(500),
      )
      .default({})
      .superRefine((headers, ctx) => {
        for (const [name, value] of Object.entries(headers)) {
          if (RESERVED_HEADER_PATTERN.test(name)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [name],
              message: `Header "${name}" carries credentials; use the secret field instead.`,
            });
          }
          if (/^\s*$/u.test(value)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [name],
              message: `Header "${name}" must not be empty.`,
            });
          }
        }
      }),
    params: z
      .record(z.string().max(64), z.unknown())
      .default({})
      .refine(
        (params) => Buffer.byteLength(JSON.stringify(params), 'utf8') <= MAX_PROVIDER_PARAMS_BYTES,
        { message: 'params must be at most 8KB of JSON' },
      ),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
    maxRetries: z.number().int().min(0).max(3).default(2),
    enabled: z.boolean().default(true),
    capabilityOverrides: z
      .object({
        text_generation: z.boolean().optional(),
        image_generation: z.boolean().optional(),
        image_reference_input: z.boolean().optional(),
        image_editing: z.boolean().optional(),
        structured_output: z.boolean().optional(),
      })
      .default({}),
  })
  .strict();

export type ProviderInput = z.infer<typeof providerInputSchema>;

export const selectionSchema = z
  .object({
    textProviderId: z.string().trim().max(64).nullable(),
    imageProviderId: z.string().trim().max(64).nullable(),
  })
  .strict();

/** A secret write: value is accepted ONCE and never read back. */
export const secretInputSchema = z
  .object({
    secret: z.string().min(1).max(4096),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  Effective capabilities (adapter declaration ∩ user narrowing)             */
/* -------------------------------------------------------------------------- */

export function effectiveCapabilities(
  declaration: CapabilityDeclaration,
  overrides: Partial<CapabilityDeclaration>,
): CapabilityDeclaration {
  return {
    text_generation: overrides.text_generation ?? declaration.text_generation,
    image_generation: overrides.image_generation ?? declaration.image_generation,
    image_reference_input: overrides.image_reference_input ?? declaration.image_reference_input,
    image_editing: overrides.image_editing ?? declaration.image_editing,
    structured_output: overrides.structured_output ?? declaration.structured_output,
  };
}

/** Tasks a provider may be selected for, derived from its capabilities. */
export function supportedTasks(caps: CapabilityDeclaration): ProviderTask[] {
  const tasks: ProviderTask[] = [];
  if (caps.text_generation) tasks.push('text');
  if (caps.image_generation) tasks.push('image');
  return tasks;
}
