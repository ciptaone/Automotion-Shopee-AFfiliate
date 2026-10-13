/**
 * Provider service (Part 6 §2–§5): CRUD, validation, readiness and bounded
 * test actions for user-configured text/image providers.
 *
 * Invariants enforced here:
 *  - configuration and secrets are separate; a saved secret is never returned
 *    (only presence + masked metadata),
 *  - endpoints are validated by the SSRF policy BEFORE they are stored, and
 *    re-validated before every request,
 *  - capability readiness is only `ready` after a real test for that capability,
 *  - test actions are bounded (timeout + size caps) and NEVER publish anything,
 *  - every error/detail is redacted and truncated before it leaves this module.
 */
import { randomUUID } from 'node:crypto';
import {
  AppError,
  CapabilityUnsupportedError,
  EndpointRejectedError,
  ProviderConfigError,
  ProviderNotFoundError,
} from '../core/errors.js';
import { redactString } from '../core/redact.js';
import type { CaptionGenerator, FeedProduct, ImageGenerator } from '../contracts/index.js';
import type { UsageService } from '../usage/usage-service.js';
import type { SecretStore } from '../secrets/secret-store.js';
import { maskedPreview } from '../secrets/secret-store.js';
import type { ProviderStore } from './provider-store.js';
import type { EndpointPolicy } from './endpoint-policy.js';
import type { HttpTransport } from './transport.js';
import {
  capabilitiesOf,
  createCaptionClient,
  createImageClient,
  getAdapter,
  validateAgainstAdapter,
} from './adapters.js';
import {
  providerInputSchema,
  READINESS_KEYS,
  secretInputSchema,
  selectionSchema,
  supportedTasks,
  type CapabilityDeclaration,
  type CapabilityProbe,
  type CapabilityStatus,
  type ProviderConfig,
  type ProviderInput,
  type ProviderReadiness,
  type ProviderTask,
  type ProviderWorkspace,
  type ReadinessKey,
} from './types.js';

/* -------------------------------------------------------------------------- */
/*  Public shapes                                                             */
/* -------------------------------------------------------------------------- */

export interface SecretMetadata {
  readonly present: boolean;
  /** Masked preview (e.g. `sk-••••ab`); null when absent. */
  readonly masked: string | null;
  readonly keyConfigured: boolean;
}

export interface ProviderView {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly adapterType: string;
  readonly adapterLabel: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly auth: { readonly type: string; readonly headerName?: string };
  readonly extraHeaders: Readonly<Record<string, string>>;
  readonly params: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly enabled: boolean;
  readonly capabilities: CapabilityDeclaration;
  readonly supportedTasks: readonly ProviderTask[];
  readonly secret: SecretMetadata;
  readonly readiness: ProviderReadiness;
  readonly selectedFor: readonly ProviderTask[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SelectionView {
  readonly textProviderId: string | null;
  readonly imageProviderId: string | null;
  readonly textProviderName: string | null;
  readonly imageProviderName: string | null;
  /** PART 6 §5: no automatic switching — ever. */
  readonly fallback: 'none';
  readonly note: string;
}

export type TestKind = 'connection' | 'text' | 'image';

export interface ProviderTestResult {
  readonly ok: boolean;
  readonly kind: TestKind;
  readonly providerId: string;
  readonly status: CapabilityStatus;
  readonly detail: string;
  readonly durationMs: number;
  readonly requestId: string | null;
  readonly readiness: ProviderReadiness;
  readonly text?: {
    readonly preview: string;
    readonly chars: number;
    readonly model: string;
    readonly endsWithMandatory: boolean;
  };
  readonly image?: {
    readonly mimeType: string;
    readonly width: number;
    readonly height: number;
    readonly byteLength: number;
    readonly previewDataUrl: string | null;
    readonly model: string;
  };
  readonly note: string;
}

export interface ProviderServiceOptions {
  readonly store: ProviderStore;
  readonly secrets: SecretStore;
  readonly policy: EndpointPolicy;
  readonly transport: HttpTransport;
  readonly usage: UsageService;
  readonly now?: () => Date;
}

const CONNECTION_NOTE = 'Connection test only: no content was generated and nothing was published.';
const GENERATION_NOTE =
  'Bounded test generation with fixture data. Nothing was uploaded, stored or published to Facebook/Threads.';

/* -------------------------------------------------------------------------- */
/*  Service                                                                   */
/* -------------------------------------------------------------------------- */

export class ProviderService {
  private workspace: ProviderWorkspace | null = null;
  private readonly now: () => Date;

  constructor(private readonly options: ProviderServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  get storage(): 'memory' | 'file' | 'postgres' {
    return this.options.store.kind;
  }

  get secretsStorage(): 'memory' | 'file' | 'postgres' {
    return this.options.secrets.kind;
  }

  private async load(): Promise<ProviderWorkspace> {
    if (!this.workspace) {
      this.workspace = await this.options.store.load();
    }
    return this.workspace;
  }

  /**
   * Idempotent warm-up (called from the container/server startup) so the
   * synchronous `info` readers see the persisted selection immediately after
   * boot instead of after the first request.
   */
  async init(): Promise<void> {
    await this.load();
  }

  /**
   * Synchronous selection lookup for `ProviderInfo` getters. Returns null until
   * `init()`/`load()` has run — callers treat that as "no selection yet".
   */
  selectedForSync(task: ProviderTask): ProviderConfig | null {
    const workspace = this.workspace;
    if (!workspace) return null;
    const id = task === 'text' ? workspace.textProviderId : workspace.imageProviderId;
    if (!id) return null;
    return workspace.providers.find((p) => p.id === id) ?? null;
  }

  private async save(next: ProviderWorkspace): Promise<ProviderWorkspace> {
    const doc: ProviderWorkspace = { ...next, updatedAt: this.now().toISOString() };
    await this.options.store.save(doc);
    this.workspace = doc;
    return doc;
  }

  /* ------------------------------------------------------------------ */
  /*  Reads                                                             */
  /* ------------------------------------------------------------------ */

  async list(): Promise<ProviderView[]> {
    const workspace = await this.load();
    const views = await Promise.all(
      workspace.providers.map((provider) => this.toView(provider, workspace)),
    );
    return views.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<ProviderView> {
    const workspace = await this.load();
    const provider = workspace.providers.find((entry) => entry.id === id);
    if (!provider) throw new ProviderNotFoundError(id);
    return this.toView(provider, workspace);
  }

  async selection(): Promise<SelectionView> {
    const workspace = await this.load();
    const text = workspace.providers.find((p) => p.id === workspace.textProviderId) ?? null;
    const image = workspace.providers.find((p) => p.id === workspace.imageProviderId) ?? null;
    return {
      textProviderId: text?.id ?? null,
      imageProviderId: image?.id ?? null,
      textProviderName: text?.displayName ?? null,
      imageProviderName: image?.displayName ?? null,
      fallback: 'none',
      note: 'Text and image providers are selected independently. On failure the backend reports the error — it never switches provider or falls back to a mock.',
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Writes                                                            */
  /* ------------------------------------------------------------------ */

  async create(rawInput: unknown): Promise<ProviderView> {
    const input = this.parseInput(rawInput);
    const workspace = await this.load();
    if (workspace.providers.some((p) => p.name === input.name)) {
      throw new ProviderConfigError(`A provider named "${input.name}" already exists.`);
    }
    const now = this.now().toISOString();
    const provider: ProviderConfig = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    await this.validateEndpoint(provider);

    const readiness: ProviderReadiness = {
      ...(workspace.readiness[provider.id] ?? {}),
      configuration: {
        status: 'ready',
        testedAt: now,
        detail: 'Configuration validated (schema, adapter contract and endpoint policy).',
        requestId: null,
      },
    };
    // Required-but-missing secret at creation time is a normal state: the
    // operator adds it next. Record it honestly instead of pretending readiness.
    if (provider.auth.type !== 'none' && !this.options.secrets.keyConfigured) {
      readiness['configuration'] = {
        status: 'configuration_invalid',
        testedAt: now,
        detail: 'SECRETS_ENCRYPTION_KEY is not configured, so this provider cannot store a credential.',
        requestId: null,
      };
    }

    const next: ProviderWorkspace = {
      ...workspace,
      providers: [...workspace.providers, provider],
      readiness: { ...workspace.readiness, [provider.id]: readiness },
    };
    await this.save(next);
    return this.toView(provider, next);
  }

  async update(id: string, rawPatch: unknown): Promise<ProviderView> {
    const patch = this.parseInput(rawPatch);
    const workspace = await this.load();
    const existing = workspace.providers.find((p) => p.id === id);
    if (!existing) throw new ProviderNotFoundError(id);
    if (patch.name !== existing.name && workspace.providers.some((p) => p.name === patch.name)) {
      throw new ProviderConfigError(`A provider named "${patch.name}" already exists.`);
    }

    const candidate: ProviderConfig = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: this.now().toISOString(),
    };
    await this.validateEndpoint(candidate);

    // Disabling/deleting must be safe: an active selection may not be broken
    // silently, and there is no fallback to hide behind.
    const inUseFor: ProviderTask[] = [];
    if (workspace.textProviderId === id) inUseFor.push('text');
    if (workspace.imageProviderId === id) inUseFor.push('image');
    if (!candidate.enabled && inUseFor.length > 0) {
      throw new AppError({
        code: 'PROVIDER_IN_USE',
        category: 'conflict',
        message: `Provider "${candidate.displayName}" is selected for ${inUseFor.join(' and ')} generation. Deselect it first.`,
        expose: true,
        retryable: false,
        context: { providerId: id, selectedFor: inUseFor },
      });
    }

    const readiness = { ...(workspace.readiness[id] ?? {}) };
    readiness['configuration'] = {
      status: 'ready',
      testedAt: this.now().toISOString(),
      detail: 'Configuration re-validated after update; capability tests still apply.',
      requestId: null,
    };
    // A changed endpoint/model/auth invalidates previous capability results —
    // a "ready" that predates the change would be a lie.
    for (const key of ['text_generation', 'image_generation', 'image_reference_input', 'image_editing', 'structured_output', 'authentication'] as const) {
      const previous = readiness[key];
      if (previous && previous.status !== 'not_configured') {
        readiness[key] = {
          status: 'not_configured',
          testedAt: null,
          detail: 'Configuration changed since the last test; run the test again.',
          requestId: null,
        };
      }
    }

    const next: ProviderWorkspace = {
      ...workspace,
      providers: workspace.providers.map((p) => (p.id === id ? candidate : p)),
      readiness: { ...workspace.readiness, [id]: readiness },
    };
    await this.save(next);
    return this.toView(candidate, next);
  }

  async remove(id: string): Promise<{ deleted: boolean }> {
    const workspace = await this.load();
    const provider = workspace.providers.find((p) => p.id === id);
    if (!provider) throw new ProviderNotFoundError(id);

    const selectedFor: ProviderTask[] = [];
    if (workspace.textProviderId === id) selectedFor.push('text');
    if (workspace.imageProviderId === id) selectedFor.push('image');
    if (selectedFor.length > 0) {
      throw new AppError({
        code: 'PROVIDER_IN_USE',
        category: 'conflict',
        message: `Provider "${provider.displayName}" is selected for ${selectedFor.join(' and ')} generation. Deselect it first.`,
        expose: true,
        retryable: false,
        context: { providerId: id, selectedFor },
      });
    }

    const readiness = { ...workspace.readiness };
    delete readiness[id];
    await this.save({
      ...workspace,
      providers: workspace.providers.filter((p) => p.id !== id),
      readiness,
    });
    // Credential goes with the configuration — no orphaned secrets.
    await this.options.secrets.delete(id);
    return { deleted: true };
  }

  async setSelection(rawSelection: unknown): Promise<SelectionView> {
    const parsed = selectionSchema.safeParse(rawSelection);
    if (!parsed.success) {
      throw new ProviderConfigError('Selection must contain textProviderId and imageProviderId (string or null).');
    }
    const workspace = await this.load();

    for (const [task, id] of [
      ['text', parsed.data.textProviderId],
      ['image', parsed.data.imageProviderId],
    ] as const) {
      if (id === null) continue;
      const provider = workspace.providers.find((p) => p.id === id);
      if (!provider) throw new ProviderNotFoundError(id);
      this.assertCapability(provider, task);
      if (!provider.enabled) {
        throw new ProviderConfigError(`Provider "${provider.displayName}" is disabled; enable it before selecting it.`);
      }
    }

    await this.save({
      ...workspace,
      textProviderId: parsed.data.textProviderId,
      imageProviderId: parsed.data.imageProviderId,
    });
    return this.selection();
  }

  /* ------------------------------------------------------------------ */
  /*  Secrets (write-only)                                              */
  /* ------------------------------------------------------------------ */

  async setSecret(id: string, rawInput: unknown): Promise<SecretMetadata & { updated: boolean }> {
    const provider = (await this.load()).providers.find((p) => p.id === id);
    if (!provider) throw new ProviderNotFoundError(id);
    const parsed = secretInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ProviderConfigError('secret must be a non-empty string (max 4096 characters).');
    }
    if (provider.auth.type === 'none') {
      throw new ProviderConfigError(
        `Provider "${provider.displayName}" uses auth.type "none"; set an auth type before storing a credential.`,
      );
    }
    if (!this.options.secrets.keyConfigured) {
      throw new AppError({
        code: 'SECRETS_KEY_MISSING',
        category: 'configuration',
        message: 'Secrets cannot be stored: SECRETS_ENCRYPTION_KEY is not configured on the server.',
        expose: true,
        retryable: false,
        context: {},
      });
    }
    await this.options.secrets.set(id, parsed.data.secret);
    const workspace = await this.load();
    const readiness = { ...(workspace.readiness[id] ?? {}) };
    if (readiness['authentication']?.status === 'authentication_failed') {
      readiness['authentication'] = {
        status: 'not_configured',
        testedAt: null,
        detail: 'Credential replaced; run a generation test to verify it.',
        requestId: null,
      };
      await this.save({ ...workspace, readiness: { ...workspace.readiness, [id]: readiness } });
    }
    return { ...(await this.secretMetadata(provider)), present: true, updated: true };
  }

  async deleteSecret(id: string): Promise<SecretMetadata & { deleted: boolean }> {
    const provider = (await this.load()).providers.find((p) => p.id === id);
    if (!provider) throw new ProviderNotFoundError(id);
    await this.options.secrets.delete(id);
    return { ...(await this.secretMetadata(provider)), present: false, deleted: true };
  }

  /* ------------------------------------------------------------------ */
  /*  Test actions (bounded, never publishing)                           */
  /* ------------------------------------------------------------------ */

  async testConnection(id: string): Promise<ProviderTestResult> {
    const provider = await this.requireProvider(id);
    const startedAt = Date.now();

    let base: URL;
    try {
      base = this.options.policy.validateShape(provider.baseUrl);
    } catch (error) {
      const detail = safeDetail(error);
      const readiness = await this.recordProbe(id, 'configuration', 'configuration_invalid', detail, null);
      return {
        ok: false,
        kind: 'connection',
        providerId: id,
        status: 'configuration_invalid',
        detail,
        durationMs: Date.now() - startedAt,
        requestId: null,
        readiness,
        note: CONNECTION_NOTE,
      };
    }

    let status: CapabilityStatus;
    let detail: string;
    let requestId: string | null = null;

    try {
      const response = await this.options.transport.request({
        url: base.toString(),
        method: 'GET',
        headers: { Accept: 'application/json', ...provider.extraHeaders },
        timeoutMs: Math.min(provider.timeoutMs, 10_000),
        maxResponseBytes: 64 * 1024,
        service: provider.displayName,
        operation: 'test_connection',
        responseKind: 'binary',
      });
      requestId = response.requestId;
      if (response.status === 401 || response.status === 403) {
        status = 'ready';
        detail =
          `Endpoint reachable (HTTP ${response.status}); credentials were not verified by this probe. ` +
          'Run a text/image generation test to verify authentication.';
      } else if (response.status >= 500) {
        status = 'temporarily_unavailable';
        detail = `Endpoint reachable but returned HTTP ${response.status} (server error).`;
      } else {
        status = 'ready';
        detail = `Endpoint reachable (HTTP ${response.status}). Capabilities still need their own tests.`;
      }
    } catch (error) {
      // Map the transport's typed error onto the readiness vocabulary: an HTTP
      // 401 is an AUTHENTICATION problem, a 429 is a rate limit, a timeout or
      // 5xx is temporary — never a generic "test_failed".
      status = classifyTestFailure(error);
      detail = safeDetail(error);
    }

    let readiness = await this.recordProbe(id, 'configuration', status, detail, requestId);
    if (status === 'authentication_failed') {
      readiness = await this.recordProbe(id, 'authentication', status, detail, requestId);
    }
    return {
      ok: status === 'ready',
      kind: 'connection',
      providerId: id,
      status,
      detail,
      durationMs: Date.now() - startedAt,
      requestId,
      readiness,
      note: CONNECTION_NOTE,
    };
  }

  async testText(id: string): Promise<ProviderTestResult> {
    const provider = await this.requireProvider(id);
    const startedAt = Date.now();
    try {
      this.assertCapability(provider, 'text');
    } catch (error) {
      const detail = safeDetail(error);
      const readiness = await this.recordProbe(id, 'text_generation', 'capability_unsupported', detail, null);
      return {
        ok: false,
        kind: 'text',
        providerId: id,
        status: 'capability_unsupported',
        detail,
        durationMs: Date.now() - startedAt,
        requestId: null,
        readiness,
        note: GENERATION_NOTE,
      };
    }

    let client: CaptionGenerator;
    try {
      client = createCaptionClient(await this.contextFor(provider));
    } catch (error) {
      // A missing/undecryptable credential is an AUTHENTICATION problem, not a
      // generic test failure — classify it like any other test error.
      const status = classifyTestFailure(error);
      const detail = safeDetail(error);
      const readiness = await this.recordFailureProbes(id, 'text_generation', status, detail, null);
      return {
        ok: false,
        kind: 'text',
        providerId: id,
        status,
        detail,
        durationMs: Date.now() - startedAt,
        requestId: null,
        readiness,
        note: GENERATION_NOTE,
      };
    }

    try {
      const generated = await client.generate(TEST_CAPTION_REQUEST);
      const detail = `Text generation succeeded with model "${provider.model}".`;
      // A successful generation also proves the credential worked.
      let readiness = await this.recordProbe(id, 'text_generation', 'ready', detail, null);
      if (provider.auth.type !== 'none') {
        readiness = await this.recordProbe(
          id,
          'authentication',
          'ready',
          `Credential accepted (model "${provider.model}").`,
          null,
        );
      }
      await this.recordUsage(provider, 'test_text', 'success', Date.now() - startedAt, {
        images: 0,
      });
      return {
        ok: true,
        kind: 'text',
        providerId: id,
        status: 'ready',
        detail,
        durationMs: Date.now() - startedAt,
        requestId: null,
        readiness,
        text: {
          preview: redactString(generated.fullText).slice(0, 600),
          chars: generated.fullText.length,
          model: generated.model,
          endsWithMandatory: /#ai\s+#automation$/i.test(generated.fullText.replace(/\s+$/, '')),
        },
        note: GENERATION_NOTE,
      };
    } catch (error) {
      const status = classifyTestFailure(error);
      const detail = safeDetail(error);
      const readiness = await this.recordFailureProbes(id, 'text_generation', status, detail, null);
      await this.recordUsage(provider, 'test_text', 'error', Date.now() - startedAt, {
        errorCode: errorCodeOf(error),
      });
      return {
        ok: false,
        kind: 'text',
        providerId: id,
        status,
        detail,
        durationMs: Date.now() - startedAt,
        requestId: null,
        readiness,
        note: GENERATION_NOTE,
      };
    }
  }

  async testImage(id: string): Promise<ProviderTestResult> {
    const provider = await this.requireProvider(id);
    const startedAt = Date.now();
    try {
      this.assertCapability(provider, 'image');
    } catch (error) {
      const detail = safeDetail(error);
      const readiness = await this.recordProbe(id, 'image_generation', 'capability_unsupported', detail, null);
      return {
        ok: false,
        kind: 'image',
        providerId: id,
        status: 'capability_unsupported',
        detail,
        durationMs: Date.now() - startedAt,
        requestId: null,
        readiness,
        note: GENERATION_NOTE,
      };
    }

    let client: ImageGenerator;
    try {
      client = createImageClient(await this.contextFor(provider));
    } catch (error) {
      // A missing/undecryptable credential is an AUTHENTICATION problem.
      const status = classifyTestFailure(error);
      const detail = safeDetail(error);
      const readiness = await this.recordFailureProbes(id, 'image_generation', status, detail, null);
      return {
        ok: false,
        kind: 'image',
        providerId: id,
        status,
        detail,
        durationMs: Date.now() - startedAt,
        requestId: null,
        readiness,
        note: GENERATION_NOTE,
      };
    }

    try {
      const image = await client.generate(TEST_IMAGE_REQUEST);
      const detail = `Image generation succeeded with model "${provider.model}".`;
      // A successful generation also proves the credential worked.
      let readiness = await this.recordProbe(id, 'image_generation', 'ready', detail, null);
      if (provider.auth.type !== 'none') {
        readiness = await this.recordProbe(
          id,
          'authentication',
          'ready',
          `Credential accepted (model "${provider.model}").`,
          null,
        );
      }
      await this.recordUsage(provider, 'test_image', 'success', Date.now() - startedAt, {
        images: 1,
      });
      const preview =
        image.bytes.byteLength <= 1_500_000
          ? `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}`
          : null;
      return {
        ok: true,
        kind: 'image',
        providerId: id,
        status: 'ready',
        detail,
        durationMs: Date.now() - startedAt,
        requestId: null,
        readiness,
        image: {
          mimeType: image.mimeType,
          width: image.width,
          height: image.height,
          byteLength: image.bytes.byteLength,
          previewDataUrl: preview,
          model: image.model,
        },
        note: GENERATION_NOTE,
      };
    } catch (error) {
      const status = classifyTestFailure(error);
      const detail = safeDetail(error);
      const readiness = await this.recordFailureProbes(id, 'image_generation', status, detail, null);
      await this.recordUsage(provider, 'test_image', 'error', Date.now() - startedAt, {
        errorCode: errorCodeOf(error),
      });
      return {
        ok: false,
        kind: 'image',
        providerId: id,
        status,
        detail,
        durationMs: Date.now() - startedAt,
        requestId: null,
        readiness,
        note: GENERATION_NOTE,
      };
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Resolution used by the generation router                           */
  /* ------------------------------------------------------------------ */

  /** Find a provider by id (throws when missing). */
  async requireProvider(id: string): Promise<ProviderConfig> {
    const workspace = await this.load();
    const provider = workspace.providers.find((p) => p.id === id);
    if (!provider) throw new ProviderNotFoundError(id);
    return provider;
  }

  /** Selected provider for a task, or null when no selection is configured. */
  async selectedFor(task: ProviderTask): Promise<ProviderConfig | null> {
    const workspace = await this.load();
    const id = task === 'text' ? workspace.textProviderId : workspace.imageProviderId;
    if (!id) return null;
    const provider = workspace.providers.find((p) => p.id === id) ?? null;
    if (!provider) return null;
    return provider;
  }

  /** Decrypted credential for outbound use — server-side only, never returned. */
  async secretFor(provider: ProviderConfig): Promise<string | null> {
    if (provider.auth.type === 'none') return null;
    return this.options.secrets.get(provider.id);
  }

  async contextFor(provider: ProviderConfig): Promise<{
    config: ProviderConfig;
    secret: string | null;
    transport: HttpTransport;
  }> {
    const secret = await this.secretFor(provider);
    if (provider.auth.type !== 'none' && (!secret || secret.length === 0)) {
      throw new AppError({
        code: 'PROVIDER_SECRET_UNAVAILABLE',
        category: 'configuration',
        message: `Provider "${provider.displayName}" requires a credential that is not stored (or cannot be decrypted). Add the API key before using it.`,
        expose: true,
        retryable: false,
        context: { providerId: provider.id },
      });
    }
    return { config: provider, secret, transport: this.options.transport };
  }

  assertCapability(provider: ProviderConfig, task: ProviderTask): void {
    const caps = capabilitiesOf(provider);
    if (task === 'text' && !caps.text_generation) {
      throw new CapabilityUnsupportedError(provider.displayName, 'text generation');
    }
    if (task === 'image' && !caps.image_generation) {
      throw new CapabilityUnsupportedError(provider.displayName, 'image generation');
    }
    if (!provider.enabled) {
      throw new ProviderConfigError(`Provider "${provider.displayName}" is disabled.`);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Internals                                                          */
  /* ------------------------------------------------------------------ */

  private parseInput(raw: unknown): ProviderInput {
    const parsed = providerInputSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ProviderConfigError(
        `Provider configuration rejected: ${first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'invalid input'}`,
        { issues: parsed.error.issues.map((i) => ({ rule: i.path.join('.') || 'body', message: i.message })) },
      );
    }
    validateAgainstAdapter({
      ...(parsed.data as ProviderConfig),
      id: 'preview',
      createdAt: '',
      updatedAt: '',
    });
    return parsed.data;
  }

  private async validateEndpoint(provider: ProviderConfig): Promise<void> {
    try {
      await this.options.policy.validate(provider.baseUrl);
    } catch (error) {
      if (error instanceof EndpointRejectedError) throw error;
      throw new ProviderConfigError('Endpoint could not be validated.');
    }
  }

  private async toView(provider: ProviderConfig, workspace: ProviderWorkspace): Promise<ProviderView> {
    const adapter = getAdapter(provider.adapterType);
    const caps = capabilitiesOf(provider);
    const hasSecret = await this.options.secrets.has(provider.id);
    let masked: string | null = null;
    if (hasSecret) {
      const value = await this.options.secrets.get(provider.id);
      masked = value ? maskedPreview(value) : '••••';
    }
    const selectedFor: ProviderTask[] = [];
    if (workspace.textProviderId === provider.id) selectedFor.push('text');
    if (workspace.imageProviderId === provider.id) selectedFor.push('image');

    return {
      id: provider.id,
      name: provider.name,
      displayName: provider.displayName,
      adapterType: provider.adapterType,
      adapterLabel: adapter.label,
      baseUrl: provider.baseUrl,
      model: provider.model,
      auth: { type: provider.auth.type, ...(provider.auth.headerName ? { headerName: provider.auth.headerName } : {}) },
      extraHeaders: provider.extraHeaders,
      params: provider.params,
      timeoutMs: provider.timeoutMs,
      maxRetries: provider.maxRetries,
      enabled: provider.enabled,
      capabilities: caps,
      supportedTasks: supportedTasks(caps),
      secret: { present: hasSecret, masked, keyConfigured: this.options.secrets.keyConfigured },
      readiness: this.readinessOf(provider, workspace),
      selectedFor,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
    };
  }

  /**
   * Stored probes + a live configuration check. Capabilities stay
   * `not_configured` until a real test produced them — a stored `ready` that
   * the current configuration can no longer support is downgraded here.
   */
  private readinessOf(provider: ProviderConfig, workspace: ProviderWorkspace): ProviderReadiness {
    const stored = workspace.readiness[provider.id] ?? {};
    const caps = capabilitiesOf(provider);
    const result: ProviderReadiness = {};

    const configurationStatus = this.configurationStatus(provider);
    const storedConfiguration = stored['configuration'];
    result['configuration'] = storedConfiguration
      ? // A recorded FAILED connection test is not erased by a shape check that
        // happens to pass — only a new test (or a config change) clears it.
        isFailureStatus(storedConfiguration.status)
          ? storedConfiguration
          : { ...storedConfiguration, status: configurationStatus.status, detail: configurationStatus.detail }
      : {
          status: configurationStatus.status,
          testedAt: provider.updatedAt,
          detail: configurationStatus.detail,
          requestId: null,
        };

    result['authentication'] = stored['authentication'] ?? {
      status: provider.auth.type === 'none' ? 'capability_unsupported' : 'not_configured',
      testedAt: null,
      detail:
        provider.auth.type === 'none'
          ? 'This adapter type does not use credentials.'
          : 'Authentication has not been verified yet; run a generation test.',
      requestId: null,
    };

    for (const key of ['text_generation', 'image_generation', 'image_reference_input', 'image_editing', 'structured_output'] as const) {
      const supported =
        key === 'text_generation'
          ? caps.text_generation
          : key === 'image_generation'
            ? caps.image_generation
            : caps[key];
      const probe = stored[key];
      if (!supported) {
        result[key] = {
          status: 'capability_unsupported',
          testedAt: probe?.testedAt ?? null,
          detail: `Adapter "${adapterLabelOf(provider)}" does not declare this capability.`,
          requestId: null,
        };
        continue;
      }
      result[key] = probe ?? {
        status: 'not_configured',
        testedAt: null,
        detail: 'Not tested yet.',
        requestId: null,
      };
    }
    return result;
  }

  private configurationStatus(provider: ProviderConfig): { status: CapabilityStatus; detail: string } {
    try {
      this.options.policy.validateShape(provider.baseUrl);
    } catch (error) {
      return { status: 'configuration_invalid', detail: safeDetail(error) };
    }
    if (provider.auth.type !== 'none' && !this.options.secrets.keyConfigured) {
      return {
        status: 'configuration_invalid',
        detail: 'SECRETS_ENCRYPTION_KEY is not configured, so this provider cannot use a credential.',
      };
    }
    return { status: 'ready', detail: 'Configuration and endpoint policy checks pass.' };
  }

  private async recordProbe(
    id: string,
    key: ReadinessKey,
    status: CapabilityStatus,
    detail: string,
    requestId: string | null,
  ): Promise<ProviderReadiness> {
    const workspace = await this.load();
    const probe: CapabilityProbe = {
      status,
      testedAt: this.now().toISOString(),
      detail: safeText(detail),
      requestId,
    };
    const forProvider = { ...(workspace.readiness[id] ?? {}), [key]: probe };
    const readiness = { ...workspace.readiness, [id]: forProvider };
    await this.save({ ...workspace, readiness });
    return this.readinessById(id);
  }

  /**
   * Record a failed test: the task probe always, plus the authentication probe
   * when the failure was an authentication problem (401/403, missing or
   * undecryptable credential). Returns the refreshed readiness.
   */
  private async recordFailureProbes(
    id: string,
    taskKey: ReadinessKey,
    status: CapabilityStatus,
    detail: string,
    requestId: string | null,
  ): Promise<ProviderReadiness> {
    let readiness = await this.recordProbe(id, taskKey, status, detail, requestId);
    if (status === 'authentication_failed' && taskKey !== 'authentication') {
      readiness = await this.recordProbe(id, 'authentication', status, detail, requestId);
    }
    return readiness;
  }

  private async readinessById(id: string): Promise<ProviderReadiness> {
    const workspace = await this.load();
    const provider = workspace.providers.find((p) => p.id === id);
    if (!provider) return {};
    return this.readinessOf(provider, workspace);
  }

  private async secretMetadata(provider: ProviderConfig): Promise<SecretMetadata> {
    const present = await this.options.secrets.has(provider.id);
    if (!present) {
      return { present: false, masked: null, keyConfigured: this.options.secrets.keyConfigured };
    }
    const value = await this.options.secrets.get(provider.id);
    return {
      present: true,
      masked: value ? maskedPreview(value) : '••••',
      keyConfigured: this.options.secrets.keyConfigured,
    };
  }

  private async recordUsage(
    provider: ProviderConfig,
    operation: 'test_text' | 'test_image',
    status: 'success' | 'error',
    latencyMs: number,
    extra: { images?: number; errorCode?: string },
  ): Promise<void> {
    await this.options.usage.record({
      providerId: provider.id,
      providerName: provider.displayName,
      adapterType: provider.adapterType,
      model: provider.model,
      operation,
      status,
      latencyMs,
      images: extra.images ?? null,
      costUsd: null,
      costKind: 'unknown',
      errorCode: extra.errorCode ?? null,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function adapterLabelOf(provider: ProviderConfig): string {
  try {
    return getAdapter(provider.adapterType).label;
  } catch {
    return provider.adapterType;
  }
}

/** Redact + single-line + bound every message that leaves this module. */
export function safeText(raw: string): string {
  return redactString(raw).split('\n')[0]?.slice(0, 300) ?? '';
}

function safeDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return safeText(message);
}

function errorCodeOf(error: unknown): string {
  if (error instanceof AppError) return error.code;
  return error instanceof Error ? 'UPSTREAM_ERROR' : 'UNKNOWN_ERROR';
}

/**
 * Statuses produced by a FAILED test. They are preserved until a new test or a
 * configuration change clears them — a passing shape check cannot erase them.
 */
const FAILURE_STATUSES = new Set<CapabilityStatus>([
  'configuration_invalid',
  'authentication_failed',
  'rate_limited',
  'temporarily_unavailable',
  'test_failed',
]);

function isFailureStatus(status: CapabilityStatus): boolean {
  return FAILURE_STATUSES.has(status);
}

/** Map a test failure onto the PART 6 status vocabulary. */
export function classifyTestFailure(error: unknown): CapabilityStatus {
  if (error instanceof CapabilityUnsupportedError) return 'capability_unsupported';
  if (error instanceof AppError) {
    const upstream = (error.context as { upstreamStatus?: number; upstreamCode?: string | number }).upstreamStatus;
    const code = (error.context as { upstreamCode?: string | number }).upstreamCode;
    if (upstream === 401 || upstream === 403 || error.code === 'PROVIDER_SECRET_UNAVAILABLE') {
      return 'authentication_failed';
    }
    if (upstream === 429 || code === 'UPSTREAM_RATE_LIMITED') return 'rate_limited';
    if (code === 'AI_TIMEOUT' || (typeof upstream === 'number' && upstream >= 500)) {
      return 'temporarily_unavailable';
    }
    if (error.retryable) return 'temporarily_unavailable';
    return 'test_failed';
  }
  return 'test_failed';
}

/* Fixture used ONLY by the operator-triggered text test (never published). */
const TEST_PRODUCT: FeedProduct = {
  id: 'test-fixture-product',
  name: 'Produk contoh untuk uji koneksi provider (bukan produk nyata)',
  marketplace: 'Shopee',
  productUrl: 'https://shopee.co.id/-',
  affiliateUrl: 'https://example.com/aff-test',
  price: null,
  currency: null,
  commissionRate: null,
  imageUrl: null,
  category: 'Lainnya',
  rating: null,
  soldCount: null,
  raw: {},
};

const TEST_CAPTION_REQUEST: import('../contracts/index.js').CaptionGenerationRequest = {
  product: TEST_PRODUCT,
  affiliateUrl: 'https://example.com/aff-test',
  language: 'id',
  tone: 'soft_sell',
  timeoutMs: 30_000,
};

const TEST_IMAGE_REQUEST: import('../contracts/index.js').ImageGenerationRequest = {
  seed: 1,
  prompt:
    'A plain, neutral product-photo style test image of a simple cardboard box on a white background. ' +
    'No logos, no text, no brand marks. Flat studio lighting.',
  width: 512,
  height: 512,
  referenceImageUrls: [],
  timeoutMs: 60_000,
};

export { READINESS_KEYS };
