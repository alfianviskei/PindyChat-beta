import type { ExtendedJsonSchema } from '../registry/schema';

/**
 * Qwen (Alibaba Model Studio) image generation.
 *
 * The token-plan gateway does not expose an OpenAI-compatible
 * `/images/generations` route (it answers 404), and `qwen-image-3.0-pro`
 * replies in DashScope's own envelope even when called through
 * `/compatible-mode/v1/chat/completions`:
 *
 * ```json
 * { "request_id": "...", "output": { "choices": [ { "message": {
 *     "content": [ { "type": "image", "image": "https://...signed...png" } ] } } ] },
 *   "usage": { "output_width": 1664, "output_height": 928, "output_image_count": 1 } }
 * ```
 *
 * There is no top-level `choices`, so LangChain cannot parse it and the model
 * can never be registered as an ordinary custom endpoint. Everything below
 * therefore speaks the native route directly.
 */

/** Native multimodal-generation path, relative to the gateway origin. */
export const QWEN_MULTIMODAL_PATH = '/api/v1/services/aigc/multimodal-generation/generation';

/**
 * Origin used when no base URL is configured. Must be the `token-plan` host:
 * the same key returns `InvalidApiKey` against the pay-as-you-go
 * `maas.qwencloudapi.com` origin.
 */
export const QWEN_DEFAULT_ORIGIN = 'https://token-plan.maas.qwencloudapi.com';

/**
 * Canvas sizes accepted by `qwen-image-3.0-pro`, keyed by the aspect ratio a
 * model is likely to ask for. DashScope takes `"<width>*<height>"`, not
 * `"1024x1024"`. Every entry below was verified to return HTTP 200 with a PNG
 * of exactly the requested pixel dimensions.
 */
export const QWEN_IMAGE_SIZES: Readonly<Record<string, string>> = {
  '1:1': '1328*1328',
  '16:9': '1664*928',
  '9:16': '928*1664',
  '4:3': '1472*1140',
  '3:4': '1140*1472',
  '3:2': '1584*1056',
  '2:3': '1056*1584',
};

/** Fallback canvas when the caller omits or names an unknown aspect ratio. */
export const QWEN_DEFAULT_ASPECT_RATIO = '1:1';

/**
 * Resolves the native multimodal-generation URL from a configured base URL.
 *
 * Accepts any of the shapes an operator is likely to paste, because the same
 * credential serves the chat endpoint too and its base URL is already
 * `.../compatible-mode/v1`:
 *
 * - a bare origin (`https://token-plan.maas.qwencloudapi.com`)
 * - the OpenAI-compatible base (`.../compatible-mode/v1`)
 * - the native URL itself (returned unchanged)
 *
 * Only the origin is kept; the path is always rebuilt, since
 * `/compatible-mode/v1/images/generations` does not exist on this gateway.
 */
export function resolveQwenMultimodalUrl(baseUrl?: string | null): string {
  const candidate = (baseUrl ?? '').trim();
  if (!candidate) {
    return `${QWEN_DEFAULT_ORIGIN}${QWEN_MULTIMODAL_PATH}`;
  }
  if (candidate.endsWith(QWEN_MULTIMODAL_PATH)) {
    return candidate;
  }
  try {
    const { origin } = new URL(candidate);
    return `${origin}${QWEN_MULTIMODAL_PATH}`;
  } catch {
    // Not an absolute URL (e.g. a host-only string). Treat it as the origin.
    return `${candidate.replace(/\/+$/, '')}${QWEN_MULTIMODAL_PATH}`;
  }
}

/** Maps a model-supplied aspect ratio onto a verified Qwen canvas size. */
export function resolveQwenImageSize(aspectRatio?: string | null): string {
  const key = (aspectRatio ?? '').trim();
  return QWEN_IMAGE_SIZES[key] ?? QWEN_IMAGE_SIZES[QWEN_DEFAULT_ASPECT_RATIO];
}

export interface QwenImageRequestOptions {
  model: string;
  prompt: string;
  /** DashScope canvas string, e.g. `"1328*1328"`. */
  size?: string;
  /** Lets Qwen rewrite the prompt for better results. Defaults to `true`. */
  promptExtend?: boolean;
  /** Adds the provider watermark. Defaults to `false`. */
  watermark?: boolean;
  negativePrompt?: string;
  seed?: number;
}

/** Builds the native DashScope request body for image generation. */
export function buildQwenImageRequest(options: QwenImageRequestOptions): Record<string, unknown> {
  const { model, prompt, size, promptExtend, watermark, negativePrompt, seed } = options;

  const parameters: Record<string, unknown> = {
    // Qwen's own prompt rewriting is on by default upstream; keep it explicit
    // so the value cannot drift with a gateway release.
    prompt_extend: promptExtend ?? true,
    watermark: watermark ?? false,
  };
  if (size) {
    parameters.size = size;
  }
  if (negativePrompt) {
    parameters.negative_prompt = negativePrompt;
  }
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    parameters.seed = seed;
  }

  return {
    model,
    input: {
      messages: [{ role: 'user', content: [{ text: prompt }] }],
    },
    parameters,
  };
}

/**
 * Pulls every generated image URL out of a DashScope response.
 *
 * Tolerates the shapes the gateway has been observed to return: the multimodal
 * `content[]` array (with or without an explicit `type`), a bare string
 * `content`, and the older `output.results[].url` task envelope.
 */
export function extractQwenImageUrls(payload: unknown): string[] {
  if (payload == null || typeof payload !== 'object') {
    return [];
  }
  const output = (payload as { output?: unknown }).output;
  if (output == null || typeof output !== 'object') {
    return [];
  }

  const urls: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      urls.push(value);
    }
  };

  const choices = (output as { choices?: unknown }).choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const content = (choice as { message?: { content?: unknown } } | null)?.message?.content;
      if (typeof content === 'string') {
        push(content);
        continue;
      }
      if (!Array.isArray(content)) {
        continue;
      }
      for (const part of content) {
        if (part == null || typeof part !== 'object') {
          continue;
        }
        const item = part as Record<string, unknown>;
        // `image` carries the signed OSS URL; `url` covers the task envelope.
        push(item.image ?? item.url);
      }
    }
  }

  const results = (output as { results?: unknown }).results;
  if (Array.isArray(results)) {
    for (const result of results) {
      if (result != null && typeof result === 'object') {
        push((result as Record<string, unknown>).url);
      }
    }
  }

  return urls;
}

/**
 * Reads a DashScope error into a single human-readable line.
 *
 * The gateway sometimes answers `400` with an empty `{}` body — observed for
 * models the credential is not entitled to — so the status is the only usable
 * signal there and must be surfaced rather than swallowed.
 */
export function readQwenApiError(payload: unknown, status?: number): string | null {
  const record =
    payload != null && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  const code = typeof record?.code === 'string' ? record.code : undefined;
  const message = typeof record?.message === 'string' ? record.message : undefined;

  if (code || message) {
    return [code, message].filter(Boolean).join(': ');
  }
  if (status != null && status >= 400) {
    return `HTTP ${status} with no error body`;
  }
  return null;
}

const DEFAULT_QWEN_IMAGE_GEN_DESCRIPTION =
  `Generates high-quality images from text prompts using Alibaba's Qwen image models.

When to use \`qwen_image_gen\`:
- To create entirely new images from detailed text descriptions
- When the user requests image generation, creation, or asks to "generate an image"

When NOT to use \`qwen_image_gen\`:
- For uploading or saving existing images without modification

Generated image IDs will be returned in the response, so you can refer to them in future requests.` as const;

const getQwenImageGenDescription = () => {
  return process.env.QWEN_IMAGE_GEN_DESCRIPTION || DEFAULT_QWEN_IMAGE_GEN_DESCRIPTION;
};

const DEFAULT_QWEN_IMAGE_GEN_PROMPT_DESCRIPTION =
  `A detailed text description of the desired image. Be specific about composition, style, lighting, and subject matter; Qwen rewards concrete visual detail.` as const;

const getQwenImageGenPromptDescription = () => {
  return process.env.QWEN_IMAGE_GEN_PROMPT_DESCRIPTION || DEFAULT_QWEN_IMAGE_GEN_PROMPT_DESCRIPTION;
};

const qwenImageGenJsonSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: getQwenImageGenPromptDescription(),
    },
    aspect_ratio: {
      type: 'string',
      enum: Object.keys(QWEN_IMAGE_SIZES),
      description:
        'Aspect ratio of the generated image. Use 16:9 or 3:2 for landscape, 9:16 or 2:3 for portrait, 1:1 for square. Defaults to 1:1.',
    },
    negative_prompt: {
      type: 'string',
      description: 'Optional description of elements to keep out of the image.',
    },
  },
  required: ['prompt'],
};

export const qwenToolkit: {
  readonly qwen_image_gen: {
    readonly name: 'qwen_image_gen';
    readonly description: string;
    readonly description_for_model: string;
    readonly schema: ExtendedJsonSchema;
    readonly responseFormat: 'content_and_artifact';
  };
} = {
  qwen_image_gen: {
    name: 'qwen_image_gen' as const,
    description: getQwenImageGenDescription(),
    description_for_model: `Use this tool to generate images from text descriptions using Alibaba's Qwen image models.
1. Prompts should be detailed and specific for best results.
2. One image per function call. Create only 1 image per request.
3. Always mention the image type (photo, oil painting, watercolor painting, illustration, cartoon, drawing, vector, render, etc.) at the beginning of the prompt.
4. Use aspect_ratio to control the shape of the image: 16:9 or 3:2 for landscape, 9:16 or 2:3 for portrait, 1:1 for square (default).
5. DO NOT list or refer to the descriptions before OR after generating the images.

The prompt should be a detailed paragraph describing every part of the image in concrete, objective detail.`,
    schema: qwenImageGenJsonSchema,
    responseFormat: 'content_and_artifact' as const,
  },
} as const;

export type QwenToolkit = typeof qwenToolkit;
