const { v4: uuidv4 } = require('uuid');
const { fetch } = require('undici');
const { logger } = require('@librechat/data-schemas');
const { tool } = require('@librechat/agents/langchain/tools');
const { FileContext, ContentTypes } = require('librechat-data-provider');
const {
  qwenToolkit,
  buildQwenImageRequest,
  extractQwenImageUrls,
  readQwenApiError,
  resolveQwenImageSize,
  resolveQwenMultimodalUrl,
  getEnvProxyDispatcher,
  createMinimalRetentionRequest,
} = require('@librechat/api');

const displayMessage =
  "Qwen displayed an image. All generated images are already plainly visible, so don't repeat the descriptions in detail. Do not list download links as they are available in the UI already. The user may download the images by clicking on them, but do not mention anything about downloading to the user.";

/**
 * Creates the Qwen image generation tool.
 *
 * Talks to Alibaba's native multimodal-generation route rather than an
 * OpenAI-compatible one, because the token-plan gateway has no
 * `/images/generations` endpoint and `qwen-image-3.0-pro` answers in
 * DashScope's envelope even through `/compatible-mode/v1/chat/completions`.
 * See `packages/api/src/tools/toolkits/qwen.ts` for the verified wire shapes.
 *
 * Every collaborator is passed in by the caller; nothing here reads app
 * singletons or global state beyond the documented `QWEN_IMAGE_*` env defaults.
 *
 * @param {Object} fields - Configuration fields
 * @param {Object} fields.req - Express request, used for file retention context
 * @param {string} fields.userId
 * @param {import('librechat-data-provider').FileSources} [fields.fileStrategy]
 * @param {boolean} [fields.isAgent]
 * @param {boolean} [fields.override]
 * @param {string} [fields.QWEN_IMAGE_API_KEY] - Falls back to `DASHSCOPE_API_KEY`
 * @param {string} [fields.QWEN_IMAGE_BASE_URL]
 * @param {string} [fields.QWEN_IMAGE_MODEL]
 * @param {processFileURL} [fields.processFileURL]
 * @param {boolean} [fields.returnMetadata]
 * @returns {ReturnType<tool>}
 */
function createQwenImageTool(fields = {}) {
  const override = fields.override ?? false;

  if (!override && !fields.isAgent) {
    throw new Error('This tool is only available for agents.');
  }

  const { req, userId, fileStrategy, processFileURL, returnMetadata } = fields;

  const apiKey =
    fields.QWEN_IMAGE_API_KEY || fields.DASHSCOPE_API_KEY || process.env.QWEN_IMAGE_API_KEY || '';
  if (!apiKey && !override) {
    throw new Error('Missing QWEN_IMAGE_API_KEY (or DASHSCOPE_API_KEY) environment variable.');
  }

  const requestUrl = resolveQwenMultimodalUrl(
    fields.QWEN_IMAGE_BASE_URL || process.env.QWEN_IMAGE_BASE_URL,
  );
  const imageModel = fields.QWEN_IMAGE_MODEL || process.env.QWEN_IMAGE_MODEL || 'qwen-image-3.0-pro';
  const tenantId = req?.user?.tenantId;
  const retentionRequest = createMinimalRetentionRequest(req);

  return tool(
    async ({ prompt, aspect_ratio, negative_prompt }, runnableConfig) => {
      if (!prompt) {
        throw new Error('Missing required field: prompt');
      }

      const size = resolveQwenImageSize(aspect_ratio);
      const body = buildQwenImageRequest({
        model: imageModel,
        prompt,
        size,
        negativePrompt: negative_prompt,
      });

      logger.debug('[QwenImageGen] Generating image', { imageModel, size, url: requestUrl });

      const fetchOptions = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // The gateway streams task events unless SSE is explicitly disabled.
          'X-DashScope-SSE': 'disable',
        },
        body: JSON.stringify(body),
      };
      const dispatcher = getEnvProxyDispatcher();
      if (dispatcher) {
        fetchOptions.dispatcher = dispatcher;
      }
      if (runnableConfig?.signal) {
        fetchOptions.signal = runnableConfig.signal;
      }

      let response;
      try {
        response = await fetch(requestUrl, fetchOptions);
      } catch (error) {
        logger.error('[QwenImageGen] Request failed:', error);
        return [
          [{ type: ContentTypes.TEXT, text: `Image generation failed: ${error.message}` }],
          { content: [], file_ids: [] },
        ];
      }

      const rawText = await response.text();
      let payload;
      try {
        payload = rawText ? JSON.parse(rawText) : null;
      } catch {
        payload = null;
      }

      if (!response.ok) {
        // The gateway answers 400 with an empty `{}` for models the credential
        // is not entitled to, so fall back to the status line.
        const detail = readQwenApiError(payload, response.status) ?? rawText.slice(0, 300);
        logger.error('[QwenImageGen] API error:', detail);
        return [
          [{ type: ContentTypes.TEXT, text: `Image generation failed: ${detail}` }],
          { content: [], file_ids: [] },
        ];
      }

      const imageUrl = extractQwenImageUrls(payload)[0];
      if (!imageUrl) {
        logger.warn('[QwenImageGen] No image URL in response');
        return [
          [
            {
              type: ContentTypes.TEXT,
              text: 'No image was generated. The prompt may have been blocked; please try again.',
            },
          ],
          { content: [], file_ids: [] },
        ];
      }

      const fileName = `img-${uuidv4()}.png`;

      // Non-agent callers have no artifact channel, so persist the file and
      // return a markdown reference exactly like the other URL-based image tools.
      if (!fields.isAgent) {
        if (!processFileURL) {
          return [
            [{ type: ContentTypes.TEXT, text: 'Image generation is unavailable in this context.' }],
            { content: [], file_ids: [] },
          ];
        }
        try {
          const result = await processFileURL({
            fileStrategy,
            userId,
            URL: imageUrl,
            fileName,
            basePath: 'images',
            context: FileContext.image_generation,
            tenantId,
            req: retentionRequest,
          });
          const text = returnMetadata ? JSON.stringify(result) : `![generated image](${result.filepath})`;
          return [[{ type: ContentTypes.TEXT, text }], {}];
        } catch (error) {
          logger.error('[QwenImageGen] Failed to save image:', error);
          return [
            [{ type: ContentTypes.TEXT, text: `Failed to save the image locally: ${error.message}` }],
            { content: [], file_ids: [] },
          ];
        }
      }

      // The signed OSS URL expires (roughly 24h), so the bytes are fetched now
      // and handed to the graph as a data URL for it to persist.
      let base64;
      try {
        const imageResponse = await fetch(imageUrl, dispatcher ? { dispatcher } : {});
        if (!imageResponse.ok) {
          throw new Error(`HTTP ${imageResponse.status} fetching the generated image`);
        }
        base64 = Buffer.from(await imageResponse.arrayBuffer()).toString('base64');
      } catch (error) {
        logger.error('[QwenImageGen] Failed to download generated image:', error);
        return [
          [{ type: ContentTypes.TEXT, text: `Failed to retrieve the generated image: ${error.message}` }],
          { content: [], file_ids: [] },
        ];
      }

      const file_ids = [uuidv4()];
      const content = [
        {
          type: ContentTypes.IMAGE_URL,
          image_url: { url: `data:image/png;base64,${base64}` },
        },
      ];
      const textResponse = [
        {
          type: ContentTypes.TEXT,
          text: `${displayMessage}\n\ngenerated_image_id: "${file_ids[0]}"`,
        },
      ];

      return [textResponse, { content, file_ids }];
    },
    {
      ...qwenToolkit.qwen_image_gen,
      responseFormat: 'content_and_artifact',
    },
  );
}

module.exports = createQwenImageTool;
module.exports.createQwenImageTool = createQwenImageTool;
