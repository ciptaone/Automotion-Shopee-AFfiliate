/**
 * Concrete provider adapters (Part 6 §2/§6).
 *
 * THIS is the only module that knows provider-specific request/response shapes.
 * Everything else (service, router, pipeline, dashboard) works with the
 * capability contract from `types.ts`, so there are no provider-name
 * conditionals anywhere else in the application.
 *
 * Supported adapter types (each declared explicitly — no assumptions):
 *  - `openai_chat_completions`  text  — POST {base}/chat/completions
 *  - `openai_images`            image — POST {base}/images/generations and
 *                                       {base}/images/edits (only when the
 *                                       operator keeps image_editing enabled)
 *  - `ollama_chat`              text  — POST {base}/api/chat (self-hosted)
 *
 * Rules honoured by every adapter:
 *  - only declared capabilities are reachable (unsupported => typed error),
 *  - only whitelisted, adapter-known parameters are forwarded,
 *  - no fabricated request ids, costs, dimensions or quality scores,
 *  - the mandatory `#ai #automation` ending is applied centrally and uniformly,
 *  - reference images are used ONLY when the adapter supports them; a missing
 *    reference is never silently replaced.
 */
import {
  MANDATORY_FINAL_HASHTAGS,
  type CaptionGenerationRequest,
  type CaptionGenerator,
  type GeneratedCaption,
  type GeneratedImage,
  type ImageGenerationRequest,
  type ImageGenerator,
  type ProviderInfo,
} from '../contracts/index.js';
import { AiProviderError, CapabilityUnsupportedError, ProviderConfigError } from '../core/errors.js';
import { ensureMandatoryEnding } from '../pipeline/editorial-policy.js';
import {
  ADAPTER_TYPES,
  effectiveCapabilities,
  type AdapterType,
  type CapabilityDeclaration,
  type ProviderConfig,
} from './types.js';
import type { HttpTransport } from './transport.js';

/* -------------------------------------------------------------------------- */
/*  Adapter contract                                                          */
/* -------------------------------------------------------------------------- */

export interface AdapterContext {
  readonly config: ProviderConfig;
  /** Decrypted credential (server-side only), or null for auth-less endpoints. */
  readonly secret: string | null;
  readonly transport: HttpTransport;
}

export interface AdapterDefinition {
  readonly type: AdapterType;
  readonly label: string;
  /** Capabilities THIS request format can provide — never widened later. */
  readonly capabilities: CapabilityDeclaration;
  readonly authTypes: readonly ('none' | 'bearer' | 'header')[];
  /** Whitelisted `params` keys the adapter actually translates. */
  readonly allowedParams: readonly string[];
  createCaptionGenerator?(context: AdapterContext): CaptionGenerator;
  createImageGenerator?(context: AdapterContext): ImageGenerator;
}

/* -------------------------------------------------------------------------- */
/*  Shared helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Join a base URL with a path without duplicating slashes or `/v1`. */
function endpointUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith(path)) return base;
  return `${base}${path}`;
}

function buildHeaders(
  config: ProviderConfig,
  secret: string | null,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...config.extraHeaders,
    ...extra,
  };
  if (config.auth.type === 'bearer') {
    if (secret) headers['Authorization'] = `Bearer ${secret}`;
  } else if (config.auth.type === 'header' && config.auth.headerName && secret) {
    headers[config.auth.headerName] = secret;
  }
  return headers;
}

function pickParams(config: ProviderConfig, allowed: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    const value = config.params[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function providerInfo(config: ProviderConfig, ready: boolean, detail: string): ProviderInfo {
  return {
    name: config.displayName,
    kind: 'live',
    model: config.model,
    ready,
    detail,
  };
}

function providerFailure(
  config: ProviderConfig,
  operation: string,
  message: string,
  retryable = false,
): AiProviderError {
  return new AiProviderError(`${config.displayName} ${operation}: ${message}`, {
    service: config.displayName,
    operation,
    upstreamCode: 'AI_ADAPTER_ERROR',
  }, { retryable });
}

/**
 * Centralized caption post-processing (§9): strip anything after the mandatory
 * ending and append the hashtags when the provider omitted them. This is a
 * deterministic formatting guarantee of the BACKEND — identical for every
 * provider, never a semantic change to what the model wrote.
 */
export function applyCaptionEnding(rawText: string): string {
  const text = rawText.replace(/^```(?:json|text)?\s*/i, '').replace(/\s*```$/, '').trim();
  return ensureMandatoryEnding(text);
}

/** Extract hashtag tokens (without `#`) from caption text. */
function extractHashtags(text: string): string[] {
  return [...text.matchAll(/#([A-Za-z0-9_]+)/g)].map((match) => match[1] ?? '');
}

function buildGeneratedCaption(text: string, request: CaptionGenerationRequest, model: string): GeneratedCaption {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const ctaLine = lines.find((line) => /\b(klik|cek|beli|pesan|checkout|order|lihat|dapatkan|grab|tap)\b/i.test(line)) ?? '';
  return {
    hook: lines[0] ?? '',
    body: lines.slice(1, -1).join('\n'),
    cta: ctaLine,
    hashtags: extractHashtags(text),
    fullText: text,
    // Claim the URL only when it is literally present — never lie about it.
    embeddedUrl: text.includes(request.affiliateUrl) ? request.affiliateUrl : '',
    model,
    estimatedCostUsd: null,
  };
}

/**
 * System + user messages for caption generation. Deliberately provider-neutral
 * so both text adapters (and any future one) receive identical instructions,
 * including the editorial brief handed down by the pipeline.
 */
export function buildCaptionMessages(
  request: CaptionGenerationRequest,
): { role: 'system' | 'user'; content: string }[] {
  const product = request.product;
  const brief = request.editorialBrief;
  const mandatory = brief?.mandatoryFinalHashtags.join(' ') ?? MANDATORY_FINAL_HASHTAGS;

  const system = [
    'You write natural, fluent Indonesian captions for a Shopee affiliate account.',
    'Structure: a relevant hook line, a product-specific explanation, a clear CTA, then hashtags.',
    `The caption MUST include this affiliate URL exactly as written: ${request.affiliateUrl}`,
    brief?.disclosureHint ?? 'Include an affiliate disclosure (e.g. "link afiliasi").',
    'Use only product facts supplied in the prompt. Never invent discounts, prices, benefits or ratings.',
    brief?.claimPolicy ??
      'Never imply the account owner owns, received, tried, used, or is interested in the product.',
    `The caption MUST end exactly with "${mandatory}" and nothing after it.`,
    'Reply with the caption text only: no markdown, no quotes, no explanation.',
  ].join('\n');

  const facts = [
    `Product name: ${product.name}`,
    product.category ? `Category: ${product.category}` : null,
    product.price !== null ? `Price: ${product.price} ${product.currency ?? ''}`.trim() : 'Price: not provided',
    product.rating !== null ? `Rating: ${product.rating}/5` : 'Rating: not provided',
    product.soldCount !== null ? `Sold count: ${product.soldCount}` : 'Sold count: not provided',
    `Marketplace: ${product.marketplace}`,
    `Affiliate URL: ${request.affiliateUrl}`,
    `Language: ${request.language} · Tone: ${request.tone}`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  const feedback =
    request.regenerationAttempt && request.regenerationAttempt > 1 && request.previousIssues?.length
      ? `\nThis is attempt ${request.regenerationAttempt}. The previous caption was REJECTED for these exact reasons — fix every one:\n` +
        request.previousIssues.map((issue) => `- [${issue.rule}] ${issue.message}`).join('\n')
      : '';

  return [
    { role: 'system', content: system },
    { role: 'user', content: `${facts}${feedback}` },
  ];
}

/* -------------------------------------------------------------------------- */
/*  openai_chat_completions                                                   */
/* -------------------------------------------------------------------------- */

const OPENAI_CHAT_ALLOWED_PARAMS = [
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'seed',
  'presence_penalty',
  'frequency_penalty',
  'response_format',
] as const;

const openaiChatAdapter: AdapterDefinition = {
  type: 'openai_chat_completions',
  label: 'OpenAI-compatible chat completions',
  capabilities: {
    text_generation: true,
    image_generation: false,
    image_reference_input: false,
    image_editing: false,
    structured_output: true,
  },
  authTypes: ['none', 'bearer', 'header'],
  allowedParams: OPENAI_CHAT_ALLOWED_PARAMS,
  createCaptionGenerator(context) {
    const { config, secret, transport } = context;
    return {
      info: providerInfo(config, true, `Live adapter openai_chat_completions → ${config.baseUrl}`),
      async generate(request: CaptionGenerationRequest): Promise<GeneratedCaption> {
        const body = {
          model: config.model,
          messages: buildCaptionMessages(request),
          ...pickParams(config, OPENAI_CHAT_ALLOWED_PARAMS),
        };
        const response = await transport.request({
          url: endpointUrl(config.baseUrl, '/chat/completions'),
          method: 'POST',
          headers: buildHeaders(config, secret),
          body: JSON.stringify(body),
          timeoutMs: config.timeoutMs,
          maxResponseBytes: 2 * 1024 * 1024,
          signal: request.signal,
          service: config.displayName,
          operation: 'generate_caption',
        });
        const text = extractChatText(response.json, config);
        if (text.trim().length === 0) {
          throw providerFailure(config, 'generate_caption', 'provider returned an empty completion');
        }
        return buildGeneratedCaption(applyCaptionEnding(text), request, config.model);
      },
    };
  },
};

function extractChatText(json: unknown, config: ProviderConfig): string {
  const root = json as {
    choices?: { message?: { content?: unknown } }[];
    message?: { content?: unknown };
  } | null;
  const content = root?.choices?.[0]?.message?.content ?? root?.message?.content;
  if (typeof content === 'string') return content;
  // A structured-output endpoint may return content parts.
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === 'string' ? part : ((part as { text?: unknown })?.text ?? '')))
      .join('');
    if (typeof joined === 'string') return joined;
  }
  throw providerFailure(
    config,
    'generate_caption',
    'response did not contain a text completion (unexpected response shape)',
  );
}

/* -------------------------------------------------------------------------- */
/*  ollama_chat                                                               */
/* -------------------------------------------------------------------------- */

const OLLAMA_ALLOWED_PARAMS = ['temperature', 'top_p', 'num_predict', 'stop', 'format'] as const;

const ollamaChatAdapter: AdapterDefinition = {
  type: 'ollama_chat',
  label: 'Ollama / self-hosted chat API',
  capabilities: {
    text_generation: true,
    image_generation: false,
    image_reference_input: false,
    image_editing: false,
    structured_output: true,
  },
  authTypes: ['none', 'bearer'],
  allowedParams: OLLAMA_ALLOWED_PARAMS,
  createCaptionGenerator(context) {
    const { config, secret, transport } = context;
    const params = pickParams(config, OLLAMA_ALLOWED_PARAMS);
    return {
      info: providerInfo(config, true, `Live adapter ollama_chat → ${config.baseUrl}`),
      async generate(request: CaptionGenerationRequest): Promise<GeneratedCaption> {
        const body = {
          model: config.model,
          messages: buildCaptionMessages(request),
          stream: false,
          options: {
            ...(params['temperature'] !== undefined ? { temperature: params['temperature'] } : {}),
            ...(params['top_p'] !== undefined ? { top_p: params['top_p'] } : {}),
            ...(params['num_predict'] !== undefined ? { num_predict: params['num_predict'] } : {}),
            ...(params['stop'] !== undefined ? { stop: params['stop'] } : {}),
          },
          ...(params['format'] !== undefined ? { format: params['format'] } : {}),
        };
        const response = await transport.request({
          url: endpointUrl(config.baseUrl, '/api/chat'),
          method: 'POST',
          headers: buildHeaders(config, secret),
          body: JSON.stringify(body),
          timeoutMs: config.timeoutMs,
          maxResponseBytes: 2 * 1024 * 1024,
          signal: request.signal,
          service: config.displayName,
          operation: 'generate_caption',
        });
        const content = (response.json as { message?: { content?: unknown } } | null)?.message?.content;
        if (typeof content !== 'string' || content.trim().length === 0) {
          throw providerFailure(config, 'generate_caption', 'response did not contain message content');
        }
        return buildGeneratedCaption(applyCaptionEnding(content), request, config.model);
      },
    };
  },
};

/* -------------------------------------------------------------------------- */
/*  openai_images                                                             */
/* -------------------------------------------------------------------------- */

const OPENAI_IMAGE_ALLOWED_PARAMS = [
  'size',
  'quality',
  'style',
  'output_format',
  'response_format',
  'background',
] as const;

interface ImageDataItem {
  b64_json?: unknown;
  url?: unknown;
  size?: unknown;
  revised_prompt?: unknown;
}

const openaiImagesAdapter: AdapterDefinition = {
  type: 'openai_images',
  label: 'OpenAI-compatible images API',
  capabilities: {
    text_generation: false,
    image_generation: true,
    image_reference_input: true,
    image_editing: true,
    structured_output: false,
  },
  authTypes: ['none', 'bearer', 'header'],
  allowedParams: OPENAI_IMAGE_ALLOWED_PARAMS,
  createImageGenerator(context) {
    const { config, secret, transport } = context;
    const caps = effectiveCapabilities(openaiImagesAdapter.capabilities, config.capabilityOverrides);

    return {
      info: providerInfo(config, true, `Live adapter openai_images → ${config.baseUrl}`),
      async generate(request: ImageGenerationRequest): Promise<GeneratedImage> {
        const useEditing =
          caps.image_editing &&
          caps.image_reference_input &&
          request.referenceImageUrls.length > 0;

        const params = pickParams(config, OPENAI_IMAGE_ALLOWED_PARAMS);
        const size = resolveSize(params['size'], request);

        let json: unknown;
        if (useEditing) {
          json = await generateViaEdits({
            context,
            request,
            params,
            size,
          });
        } else {
          const body: Record<string, unknown> = {
            model: config.model,
            prompt: request.prompt,
            n: 1,
            ...(size ? { size } : {}),
            ...params,
          };
          const response = await transport.request({
            url: endpointUrl(config.baseUrl, '/images/generations'),
            method: 'POST',
            headers: buildHeaders(config, secret),
            body: JSON.stringify(body),
            timeoutMs: config.timeoutMs,
            maxResponseBytes: 8 * 1024 * 1024,
            signal: request.signal,
            service: config.displayName,
            operation: 'generate_image',
          });
          json = response.json;
        }

        const item = firstImageData(json, config);
        const { bytes, width, height, source } = await resolveImageBytes({
          context,
          item,
          request,
          fallbackWidth: request.width,
          fallbackHeight: request.height,
        });

        return {
          bytes,
          mimeType: source,
          width,
          height,
          seed: request.seed,
          model: config.model,
          estimatedCostUsd: null,
        };
      },
    };
  },
};

async function generateViaEdits(options: {
  context: AdapterContext;
  request: ImageGenerationRequest;
  params: Record<string, unknown>;
  size: string | null;
}): Promise<unknown> {
  const { context, request, params, size } = options;
  const { config, secret, transport } = context;

  const form = new FormData();
  form.append('model', config.model);
  form.append('prompt', request.prompt);
  form.append('n', '1');
  if (size) form.append('size', size);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  // Reference images MUST be the real product references handed to us. If one
  // cannot be fetched, fail loudly — never substitute an unrelated image.
  let index = 0;
  for (const url of request.referenceImageUrls.slice(0, 4)) {
    const response = await transport.request({
      url,
      method: 'GET',
      headers: {},
      timeoutMs: config.timeoutMs,
      maxResponseBytes: 10 * 1024 * 1024,
      signal: request.signal,
      service: config.displayName,
      operation: 'fetch_reference_image',
      responseKind: 'binary',
    });
    if (!response.bytes || response.bytes.byteLength === 0) {
      throw new AiProviderError(
        `${config.displayName} could not fetch reference image #${index + 1}; generation aborted rather than substituting an unrelated image.`,
        { service: config.displayName, operation: 'fetch_reference_image' },
        { retryable: false },
      );
    }
    const blob = new Blob([response.bytes], {
      type: response.contentType || 'image/png',
    });
    form.append(index === 0 ? 'image' : 'image[]', blob, `reference-${index + 1}.png`);
    index += 1;
  }

  const headers = buildHeaders(config, secret);
  // Let fetch set the multipart boundary itself.
  delete headers['Content-Type'];

  const response = await transport.request({
    url: endpointUrl(config.baseUrl, '/images/edits'),
    method: 'POST',
    headers,
    body: form,
    timeoutMs: config.timeoutMs,
    maxResponseBytes: 8 * 1024 * 1024,
    signal: request.signal,
    service: config.displayName,
    operation: 'generate_image',
  });
  return response.json;
}

function resolveSize(paramSize: unknown, request: ImageGenerationRequest): string | null {
  if (typeof paramSize === 'string' && /^\d+x\d+$/.test(paramSize)) return paramSize;
  // Only translate to a provider size when it is an exact, standard square the
  // adapter understands; otherwise let the provider use its default.
  const square = request.width === request.height ? request.width : null;
  if (square && [256, 512, 1024, 1536, 2048].includes(square)) return `${square}x${square}`;
  return null;
}

function firstImageData(json: unknown, config: ProviderConfig): ImageDataItem {
  const data = (json as { data?: ImageDataItem[] } | null)?.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw providerFailure(config, 'generate_image', 'response did not contain any image data');
  }
  return data[0] as ImageDataItem;
}

async function resolveImageBytes(options: {
  context: AdapterContext;
  item: ImageDataItem;
  request: ImageGenerationRequest;
  fallbackWidth: number;
  fallbackHeight: number;
}): Promise<{ bytes: Uint8Array; width: number; height: number; source: 'image/png' | 'image/jpeg' }> {
  const { context, item, request, fallbackWidth, fallbackHeight } = options;
  const { config, transport } = context;

  let reportedWidth = fallbackWidth;
  let reportedHeight = fallbackHeight;
  const sizeReported = typeof item.size === 'string' ? /^(\d+)x(\d+)$/.exec(item.size) : null;
  if (sizeReported) {
    reportedWidth = Number(sizeReported[1]);
    reportedHeight = Number(sizeReported[2]);
  }

  let bytes: Uint8Array;
  let mimeType: 'image/png' | 'image/jpeg' = 'image/png';

  if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
    bytes = new Uint8Array(Buffer.from(item.b64_json, 'base64'));
  } else if (typeof item.url === 'string' && item.url.length > 0) {
    const response = await transport.request({
      url: item.url,
      method: 'GET',
      headers: {},
      timeoutMs: config.timeoutMs,
      maxResponseBytes: 15 * 1024 * 1024,
      signal: request.signal,
      service: config.displayName,
      operation: 'download_image',
      responseKind: 'binary',
    });
    if (!response.bytes || response.bytes.byteLength === 0) {
      throw providerFailure(config, 'download_image', 'provider image URL returned no bytes', true);
    }
    bytes = response.bytes;
    mimeType = /jpe?g/i.test(response.contentType) ? 'image/jpeg' : 'image/png';
  } else {
    throw providerFailure(
      config,
      'generate_image',
      'response contained neither base64 image data nor a download URL',
    );
  }

  if (bytes.byteLength === 0) {
    throw providerFailure(config, 'generate_image', 'provider returned an empty image', true);
  }
  const sniffed = sniffImageType(bytes);
  if (sniffed) mimeType = sniffed;

  return { bytes, width: reportedWidth, height: reportedHeight, source: mimeType };
}

function sniffImageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Registry                                                                  */
/* -------------------------------------------------------------------------- */

export const ADAPTER_REGISTRY: Readonly<Record<AdapterType, AdapterDefinition>> = {
  openai_chat_completions: openaiChatAdapter,
  openai_images: openaiImagesAdapter,
  ollama_chat: ollamaChatAdapter,
};

export function getAdapter(type: AdapterType): AdapterDefinition {
  const adapter = ADAPTER_REGISTRY[type];
  if (!adapter) {
    throw new ProviderConfigError(`Unknown adapter type "${type}". Supported: ${ADAPTER_TYPES.join(', ')}.`);
  }
  return adapter;
}

/** Validate that a config's auth + params are supported by its adapter. */
export function validateAgainstAdapter(config: ProviderConfig): void {
  const adapter = getAdapter(config.adapterType);
  if (!adapter.authTypes.includes(config.auth.type)) {
    throw new ProviderConfigError(
      `Adapter "${adapter.type}" supports auth types [${adapter.authTypes.join(', ')}], not "${config.auth.type}".`,
    );
  }
  const unknownParams = Object.keys(config.params).filter(
    (key) => !adapter.allowedParams.includes(key),
  );
  if (unknownParams.length > 0) {
    throw new ProviderConfigError(
      `Adapter "${adapter.type}" does not support parameter(s): ${unknownParams.join(', ')}. ` +
        `Supported: ${adapter.allowedParams.join(', ')}.`,
    );
  }
  // Capability narrowing only — never widening.
  for (const [key, value] of Object.entries(config.capabilityOverrides)) {
    if (value === true && !adapter.capabilities[key as keyof CapabilityDeclaration]) {
      throw new ProviderConfigError(
        `Capability "${key}" cannot be enabled: adapter "${adapter.type}" does not support it.`,
      );
    }
  }
}

/** Build a caption generator for a config (throws when the capability is off). */
export function createCaptionClient(context: AdapterContext): CaptionGenerator {
  const adapter = getAdapter(context.config.adapterType);
  const caps = effectiveCapabilities(adapter.capabilities, context.config.capabilityOverrides);
  if (!caps.text_generation || !adapter.createCaptionGenerator) {
    throw new CapabilityUnsupportedError(context.config.displayName, 'text generation');
  }
  return adapter.createCaptionGenerator(context);
}

/** Build an image generator for a config (throws when the capability is off). */
export function createImageClient(context: AdapterContext): ImageGenerator {
  const adapter = getAdapter(context.config.adapterType);
  const caps = effectiveCapabilities(adapter.capabilities, context.config.capabilityOverrides);
  if (!caps.image_generation || !adapter.createImageGenerator) {
    throw new CapabilityUnsupportedError(context.config.displayName, 'image generation');
  }
  return adapter.createImageGenerator(context);
}

/** Effective capability declaration for a stored provider config. */
export function capabilitiesOf(config: ProviderConfig): CapabilityDeclaration {
  return effectiveCapabilities(getAdapter(config.adapterType).capabilities, config.capabilityOverrides);
}
