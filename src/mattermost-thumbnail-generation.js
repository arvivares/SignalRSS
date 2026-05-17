import OpenAI from 'openai';
import { config } from './config.js';
import { fetchWithTimeout } from './http-utils.js';
import { startLangfuseGeneration, startLangfuseTracing } from './langfuse.js';
import { cleanText } from './text-utils.js';
import { elapsedMs, formatDuration, nowMs, sleep } from './timing-utils.js';

let openaiClient = null;

function getOpenAIClient() {
  if (!config.openaiApiKey) return null;
  if (!openaiClient) {
    startLangfuseTracing();
    openaiClient = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return openaiClient;
}

function gcd(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
}

function generatedImageAspectRatio() {
  const [width, height] = String(config.mattermostGeneratedThumbnailSize || '').split('x').map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '16:9';
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function buildGeneratedThumbnailPrompt(briefing) {
  return [
    'Use case: editorial technology news image',
    'Asset type: landscape Mattermost news thumbnail',
    'Primary request: create a polished editorial image for a technology news brief.',
    `News title: ${cleanText(briefing.title).slice(0, 240)}`,
    `News summary: ${cleanText(briefing.summary).slice(0, 900)}`,
    'Style/medium: premium digital editorial illustration, cinematic but factual, modern technology journalism.',
    'Composition/framing: landscape composition, strong central visual metaphor, high readability at small thumbnail size.',
    'Lighting/mood: crisp, high contrast, serious news tone, not playful.',
    'Color palette: restrained technology palette with one strong accent color, avoid generic purple gradients.',
    'Constraints: no text, no captions, no logos, no watermarks, no fake UI screenshots, no recognizable public figures unless the brief explicitly requires them.',
    'Avoid: clutter, tiny details, stock-photo cliches, misleading product branding, distorted hands, unreadable interface text.',
  ].join('\n');
}

function estimatedPromptTokens(prompt) {
  return Math.max(1, Math.ceil(cleanText(prompt).length / 4));
}

function generatedImageOutputTokens({ size, quality }) {
  const normalizedSize = String(size || '1024x1024').toLowerCase();
  const normalizedQuality = String(quality || 'medium').toLowerCase();
  const outputTokensBySizeAndQuality = {
    '1024x1024': {
      low: 272,
      medium: 1056,
      high: 4160,
    },
    '1024x1536': {
      low: 408,
      medium: 1584,
      high: 6240,
    },
    '1536x1024': {
      low: 400,
      medium: 1568,
      high: 6208,
    },
  };
  return outputTokensBySizeAndQuality[normalizedSize]?.[normalizedQuality]
    || outputTokensBySizeAndQuality['1536x1024'].medium;
}

function startThumbnailGenerationTrace({ briefing, prompt }) {
  startLangfuseTracing();

  const isOpenRouterImageProvider = config.mattermostImageProvider === 'openrouter';
  const isNvidiaImageProvider = config.mattermostImageProvider === 'nvidia';
  const usageDetails = {
    input: estimatedPromptTokens(prompt),
    output: isOpenRouterImageProvider || isNvidiaImageProvider ? 0 : generatedImageOutputTokens({
      size: config.mattermostGeneratedThumbnailSize,
      quality: config.mattermostGeneratedThumbnailQuality,
    }),
  };
  usageDetails.total = usageDetails.input + usageDetails.output;

  return startLangfuseGeneration('signalrss-mattermost-thumbnail-generator', {
    input: {
      prompt,
      title: cleanText(briefing.title),
      summary: cleanText(briefing.summary),
    },
    model: config.mattermostImageProvider === 'nvidia'
      ? config.mattermostImageNvidiaModel
      : config.mattermostImageProvider === 'openrouter'
        ? config.mattermostImageOpenRouterModel
        : config.mattermostGeneratedThumbnailModel,
    modelParameters: {
      provider: config.mattermostImageProvider,
      size: config.mattermostGeneratedThumbnailSize,
      quality: config.mattermostGeneratedThumbnailQuality,
      n: 1,
    },
    usageDetails,
    metadata: {
      app: 'SignalRSS',
      component: 'mattermost-thumbnail-generator',
      categorySlug: briefing.category_slug || config.mattermostCategorySlug,
      clusterId: briefing.cluster_id,
      impactLevel: briefing.impact_level,
      usageIsEstimated: true,
      pricing: config.mattermostImageProvider === 'openrouter'
        ? {
          source: 'OpenRouter',
          inputUsdPer1MTokens: 0.30,
          outputUsdPer1MTokens: 2.50,
        }
        : config.mattermostImageProvider === 'nvidia'
          ? { source: 'NVIDIA Build free endpoint', costUsd: 0 }
          : undefined,
    },
  });
}

function openRouterUsageDetails(usage = {}) {
  const input = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const output = Number(usage.completion_tokens || usage.output_tokens || 0);
  const total = Number(usage.total_tokens || input + output);
  return {
    input,
    output,
    total,
  };
}

function imageProviders() {
  const providers = config.mattermostImageProviderFallbacks.length
    ? config.mattermostImageProviderFallbacks
    : [config.mattermostImageProvider];
  return [...new Set(providers.map((provider) => provider.trim()).filter(Boolean))];
}

function nvidiaImageData(body = {}) {
  const artifacts = body.artifacts || body.data || body.images || [];
  const first = Array.isArray(artifacts) ? artifacts[0] || {} : {};
  const base64 = first.base64 || first.b64_json || first.image || first.image_base64 || body.image || body.b64_json || '';
  const url = first.url || first.image_url || body.url || '';
  if (base64) return { b64_json: String(base64).replace(/^data:image\/\w+;base64,/, '') };
  if (url) return { url };
  return {};
}

function nvidiaImagePrompt(prompt) {
  return cleanText(prompt).slice(0, 800);
}

function nvidiaImageRequestBody({ endpoint, prompt }) {
  const normalizedEndpoint = String(endpoint || '').toLowerCase();
  const safePrompt = nvidiaImagePrompt(prompt);
  if (normalizedEndpoint.includes('stabilityai/stable-diffusion-3-medium')) {
    return {
      mode: 'text-to-image',
      model: 'sd3',
      prompt: safePrompt,
      aspect_ratio: generatedImageAspectRatio(),
      cfg_scale: 5,
      seed: 0,
      steps: Math.max(5, config.mattermostImageNvidiaSteps),
      output_format: 'jpeg',
    };
  }

  if (normalizedEndpoint.includes('stabilityai/stable-diffusion-xl')) {
    return {
      text_prompts: [{ text: safePrompt, weight: 1 }],
      width: 1024,
      height: 1024,
      cfg_scale: 5,
      clip_guidance_preset: 'NONE',
      sampler: 'K_DPM_2_ANCESTRAL',
      samples: 1,
      seed: 0,
      steps: Math.max(5, config.mattermostImageNvidiaSteps),
      style_preset: 'none',
    };
  }

  if (normalizedEndpoint.includes('black-forest-labs/flux')) {
    return {
      prompt: safePrompt,
      width: config.mattermostImageNvidiaWidth,
      height: config.mattermostImageNvidiaHeight,
      cfg_scale: 1,
      samples: 1,
      seed: 0,
      steps: Math.min(4, Math.max(1, config.mattermostImageNvidiaSteps)),
    };
  }

  return {
    prompt: safePrompt,
    width: config.mattermostImageNvidiaWidth,
    height: config.mattermostImageNvidiaHeight,
    cfg_scale: 1,
    samples: 1,
    seed: 0,
    steps: config.mattermostImageNvidiaSteps,
  };
}

async function generateThumbnailWithOpenAI({ prompt, timings }) {
  if (!config.openaiApiKey) {
    console.warn('OPENAI_API_KEY is not configured; cannot generate Mattermost thumbnail');
    return { data: [] };
  }

  const openai = getOpenAIClient();
  if (!openai) return { data: [] };

  const generateStart = nowMs();
  const response = await openai.images.generate({
    model: config.mattermostGeneratedThumbnailModel,
    prompt,
    size: config.mattermostGeneratedThumbnailSize,
    quality: config.mattermostGeneratedThumbnailQuality,
    n: 1,
  }, {
    timeout: config.mattermostGeneratedThumbnailTimeoutMs,
  });
  timings.thumbnail_generate_ms = elapsedMs(generateStart);
  return response;
}

async function generateThumbnailWithOpenRouter({ prompt, timings }) {
  if (!config.mattermostImageOpenRouterApiKey) {
    console.warn('MATTERMOST_IMAGE_OPENROUTER_API_KEY is not configured; cannot generate Mattermost thumbnail');
    return { data: [] };
  }

  const headers = {
    authorization: `Bearer ${config.mattermostImageOpenRouterApiKey}`,
    'content-type': 'application/json',
  };
  if (config.mattermostImageOpenRouterReferer) {
    headers['http-referer'] = config.mattermostImageOpenRouterReferer;
  }
  if (config.mattermostImageOpenRouterTitle) {
    headers['x-title'] = config.mattermostImageOpenRouterTitle;
  }

  const generateStart = nowMs();
  const response = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers,
    timeoutMs: config.mattermostGeneratedThumbnailTimeoutMs,
    body: JSON.stringify({
      model: config.mattermostImageOpenRouterModel,
      messages: [{ role: 'user', content: prompt }],
      modalities: ['image', 'text'],
      image_config: {
        aspect_ratio: generatedImageAspectRatio(),
        image_size: '1K',
      },
      stream: false,
    }),
  });
  const bodyText = await response.text();
  timings.thumbnail_generate_ms = elapsedMs(generateStart);
  if (!response.ok) {
    throw new Error(`OpenRouter image generation failed HTTP ${response.status}: ${bodyText.slice(0, 500)}`);
  }

  const body = JSON.parse(bodyText);
  const imageUrl = body.choices?.[0]?.message?.images?.[0]?.image_url?.url
    || body.choices?.[0]?.message?.images?.[0]?.imageUrl?.url
    || '';
  return imageUrl ? {
    data: [{ url: imageUrl }],
    model: body.model || config.mattermostImageOpenRouterModel,
    usage: body.usage,
  } : {
    data: [],
    model: body.model || config.mattermostImageOpenRouterModel,
    usage: body.usage,
  };
}

async function generateThumbnailWithNvidia({ prompt, timings }) {
  if (!config.mattermostImageNvidiaApiKey) {
    console.warn('MATTERMOST_IMAGE_NVIDIA_API_KEY/NVIDIA_API_KEY is not configured; cannot generate Mattermost thumbnail');
    return { data: [] };
  }

  const generateStart = nowMs();
  const response = await fetchWithTimeout(config.mattermostImageNvidiaEndpoint, {
    method: 'POST',
    timeoutMs: config.mattermostGeneratedThumbnailTimeoutMs,
    headers: {
      authorization: `Bearer ${config.mattermostImageNvidiaApiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(nvidiaImageRequestBody({
      endpoint: config.mattermostImageNvidiaEndpoint,
      prompt,
    })),
  });
  const bodyText = await response.text();
  timings.thumbnail_generate_ms = elapsedMs(generateStart);
  if (!response.ok) {
    throw new Error(`NVIDIA image generation failed HTTP ${response.status}: ${bodyText.slice(0, 500)}`);
  }

  const body = JSON.parse(bodyText);
  const image = nvidiaImageData(body);
  return {
    data: Object.keys(image).length ? [image] : [],
    model: config.mattermostImageNvidiaModel,
    usage: {
      prompt_tokens: estimatedPromptTokens(prompt),
      completion_tokens: 0,
      total_tokens: estimatedPromptTokens(prompt),
      cost: 0,
    },
  };
}

async function generateThumbnailImage({ prompt, timings, provider = config.mattermostImageProvider }) {
  if (provider === 'nvidia') {
    return generateThumbnailWithNvidia({ prompt, timings });
  }
  if (provider === 'openrouter') {
    return generateThumbnailWithOpenRouter({ prompt, timings });
  }
  return generateThumbnailWithOpenAI({ prompt, timings });
}

async function generateThumbnailImageWithRetry({ prompt, timings }) {
  const attempts = Math.max(1, config.mattermostGeneratedThumbnailAttempts);
  timings.thumbnail_generation_attempts = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const attemptStart = nowMs();
    try {
      const providers = imageProviders();
      let response = null;
      let providerErrors = [];
      for (const provider of providers) {
        try {
          response = await generateThumbnailImage({ prompt, timings, provider });
          if (response.data?.length) {
            timings.thumbnail_generation_provider = provider;
            break;
          }
          providerErrors.push(`${provider}: empty image response`);
        } catch (error) {
          providerErrors.push(`${provider}: ${error.message}`);
        }
      }
      if (!response?.data?.length) {
        throw new Error(`All image providers failed: ${providerErrors.join(' | ')}`);
      }
      const attemptMs = elapsedMs(attemptStart);
      timings.thumbnail_generation_attempts.push({
        attempt,
        ok: true,
        ms: attemptMs,
        provider: timings.thumbnail_generation_provider,
        provider_errors: providerErrors.length ? providerErrors.map((error) => cleanText(error).slice(0, 220)) : undefined,
      });
      timings.thumbnail_generation_attempt_count = timings.thumbnail_generation_attempts.length;
      return response;
    } catch (error) {
      const attemptMs = elapsedMs(attemptStart);
      timings.thumbnail_generation_attempts.push({
        attempt,
        ok: false,
        ms: attemptMs,
        error: cleanText(error.message).slice(0, 220),
      });
      timings.thumbnail_generation_attempt_count = timings.thumbnail_generation_attempts.length;

      if (attempt >= attempts) throw error;

      const backoffMs = config.mattermostGeneratedThumbnailBackoffMs[attempt - 1] ?? 0;
      console.warn(`Generated thumbnail attempt ${attempt}/${attempts} failed in ${formatDuration(attemptMs)}; retrying in ${formatDuration(backoffMs)}: ${error.message}`);
      await sleep(backoffMs);
    }
  }

  return { data: [] };
}

export async function generateThumbnailImageWithTrace({ briefing, timings }) {
  const prompt = buildGeneratedThumbnailPrompt(briefing);
  const generation = startThumbnailGenerationTrace({ briefing, prompt });

  try {
    const response = await generateThumbnailImageWithRetry({ prompt, timings });
    generation?.update({
      usageDetails: response.usage ? openRouterUsageDetails(response.usage) : undefined,
      output: {
        imageCount: response.data?.length || 0,
        hasB64: Boolean(response.data?.[0]?.b64_json),
        hasUrl: Boolean(response.data?.[0]?.url),
        usage: response.usage,
      },
    });
    return response;
  } catch (error) {
    generation?.update({
      level: 'ERROR',
      statusMessage: error.message,
      output: { error: error.message },
    });
    throw error;
  } finally {
    generation?.end();
  }
}
