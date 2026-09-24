import {
  QWEN_DEFAULT_ORIGIN,
  QWEN_IMAGE_SIZES,
  QWEN_MULTIMODAL_PATH,
  buildQwenImageRequest,
  extractQwenImageUrls,
  readQwenApiError,
  resolveQwenImageSize,
  resolveQwenMultimodalUrl,
} from './qwen';

describe('resolveQwenMultimodalUrl', () => {
  const native = `${QWEN_DEFAULT_ORIGIN}${QWEN_MULTIMODAL_PATH}`;

  it('defaults to the token-plan origin', () => {
    expect(resolveQwenMultimodalUrl()).toBe(native);
    expect(resolveQwenMultimodalUrl('')).toBe(native);
    expect(resolveQwenMultimodalUrl(null)).toBe(native);
  });

  it('rewrites the OpenAI-compatible base onto the native path', () => {
    // The chat endpoint's base URL is already `.../compatible-mode/v1`; only the
    // origin is reusable because that gateway has no /images/generations route.
    expect(
      resolveQwenMultimodalUrl('https://token-plan.maas.qwencloudapi.com/compatible-mode/v1'),
    ).toBe(native);
  });

  it('passes an already-native URL through untouched', () => {
    expect(resolveQwenMultimodalUrl(native)).toBe(native);
  });

  it('accepts a trailing-slash origin', () => {
    expect(resolveQwenMultimodalUrl('https://dashscope-intl.aliyuncs.com/')).toBe(
      `https://dashscope-intl.aliyuncs.com${QWEN_MULTIMODAL_PATH}`,
    );
  });
});

describe('resolveQwenImageSize', () => {
  it('maps every advertised aspect ratio to a verified WxH canvas', () => {
    for (const [ratio, size] of Object.entries(QWEN_IMAGE_SIZES)) {
      expect(size).toMatch(/^\d+\*\d+$/);
      expect(resolveQwenImageSize(ratio)).toBe(size);
    }
  });

  it('falls back to square for unknown or missing ratios', () => {
    expect(resolveQwenImageSize()).toBe(QWEN_IMAGE_SIZES['1:1']);
    expect(resolveQwenImageSize('21:9')).toBe(QWEN_IMAGE_SIZES['1:1']);
  });

  it('trims surrounding whitespace', () => {
    expect(resolveQwenImageSize('  16:9  ')).toBe(QWEN_IMAGE_SIZES['16:9']);
  });
});

describe('buildQwenImageRequest', () => {
  it('builds the DashScope envelope with explicit parameters', () => {
    expect(
      buildQwenImageRequest({
        model: 'qwen-image-3.0-pro',
        prompt: 'a red square',
        size: '1328*1328',
        negativePrompt: 'text',
        seed: 7,
      }),
    ).toEqual({
      model: 'qwen-image-3.0-pro',
      input: { messages: [{ role: 'user', content: [{ text: 'a red square' }] }] },
      parameters: {
        prompt_extend: true,
        watermark: false,
        size: '1328*1328',
        negative_prompt: 'text',
        seed: 7,
      },
    });
  });

  it('omits optional parameters instead of sending undefined', () => {
    const { parameters } = buildQwenImageRequest({ model: 'm', prompt: 'p' });
    expect(Object.keys(parameters).sort()).toEqual(['prompt_extend', 'watermark']);
  });

  it('drops a non-finite seed', () => {
    const { parameters } = buildQwenImageRequest({ model: 'm', prompt: 'p', seed: Number.NaN });
    expect(parameters).not.toHaveProperty('seed');
  });

  it('honours promptExtend and watermark overrides', () => {
    const { parameters } = buildQwenImageRequest({
      model: 'm',
      prompt: 'p',
      promptExtend: false,
      watermark: true,
    });
    expect(parameters.prompt_extend).toBe(false);
    expect(parameters.watermark).toBe(true);
  });
});

describe('extractQwenImageUrls', () => {
  it('reads the observed multimodal content[] shape', () => {
    expect(
      extractQwenImageUrls({
        request_id: 'r',
        output: {
          choices: [
            {
              finish_reason: 'stop',
              message: { content: [{ type: 'image', image: 'https://x/y.png' }] },
            },
          ],
        },
        usage: { output_width: 1664, output_height: 928, output_image_count: 1 },
      }),
    ).toEqual(['https://x/y.png']);
  });

  it('reads a content part that carries no explicit type', () => {
    expect(
      extractQwenImageUrls({
        output: { choices: [{ message: { content: [{ image: 'https://x/a.png' }] } }] },
      }),
    ).toEqual(['https://x/a.png']);
  });

  it('reads the legacy results[] task envelope', () => {
    expect(extractQwenImageUrls({ output: { results: [{ url: 'https://x/b.png' }] } })).toEqual([
      'https://x/b.png',
    ]);
  });

  it('returns nothing for malformed or non-image payloads', () => {
    expect(extractQwenImageUrls(null)).toEqual([]);
    expect(extractQwenImageUrls('nope')).toEqual([]);
    expect(extractQwenImageUrls({})).toEqual([]);
    expect(
      extractQwenImageUrls({ output: { choices: [{ message: { content: 'plain text' } }] } }),
    ).toEqual([]);
    expect(
      extractQwenImageUrls({
        output: { choices: [{ message: { content: [{ image: 'data:image/png;base64,AA' }] } }] },
      }),
    ).toEqual([]);
  });
});

describe('readQwenApiError', () => {
  it('surfaces a coded error body', () => {
    expect(readQwenApiError({ code: 'InvalidApiKey', message: 'bad key' }, 401)).toBe(
      'InvalidApiKey: bad key',
    );
    expect(readQwenApiError({ message: 'blocked' }, 400)).toBe('blocked');
  });

  it('surfaces the status when the body is empty', () => {
    // Observed: the gateway answers 400 with `{}` for a model the credential is
    // not entitled to, so the status is the only usable signal.
    expect(readQwenApiError({}, 400)).toBe('HTTP 400 with no error body');
    expect(readQwenApiError(null, 502)).toBe('HTTP 502 with no error body');
  });

  it('reports no error for a successful payload', () => {
    expect(readQwenApiError({ output: {} }, 200)).toBeNull();
  });
});
