import assert from 'node:assert/strict';
import test from 'node:test';

process.env.CATEGORY_BRIEFING_EXCLUDE_LEVELS = 'consumer-electronics:P3';
process.env.LLM_GITHUB_BRIEFING_MAX_BATCH_SIZE = '1';
process.env.LLM_GITHUB_IMPACT_MAX_BATCH_SIZE = '2';
process.env.LLM_OPENROUTER_BRIEFING_MAX_BATCH_SIZE = '1';
process.env.LLM_OPENROUTER_IMPACT_MAX_BATCH_SIZE = '4';
process.env.CATEGORY_BRIEFING_FREE_BATCH_SIZE = '5';
process.env.MATTERMOST_CATEGORY_SLUGS = 'artificial-intelligence,artificial-intelligence,cloud-infrastructure';
process.env.MATTERMOST_CHANNELS_BY_CATEGORY = 'artificial-intelligence:news-ai,cloud-infrastructure:news-cloud';
process.env.MATTERMOST_WEBHOOK_URL = 'https://mattermost.example/hooks/test';

const { isBriefingExcluded, filterBriefingRows } = await import('../src/briefing-exclusions.js');
const { parseJsonObject } = await import('../src/llm-utils.js');
const { llmProviderEnabled, maxBatchSizeForLlmProvider } = await import('../src/llm-provider-policy.js');
const { mattermostDestinations } = await import('../src/mattermost-destinations.js');
const { mattermostFailureRows } = await import('../src/dashboard-page.js');
const { splitCooldownRows, splitProviderRows } = await import('../src/stats-service.js');
const { batchSizeForBriefingProviders } = await import('../src/briefing-batch-policy.js');

test('briefing exclusions remove configured category/priority pairs', () => {
  assert.equal(isBriefingExcluded('consumer-electronics', 'P3'), true);
  assert.equal(isBriefingExcluded('consumer-electronics', 'P2'), false);
  assert.deepEqual(
    filterBriefingRows([
      { category: 'consumer-electronics', impact_level: 'P3', pending: 10 },
      { category: 'consumer-electronics', impact_level: 'P2', pending: 2 },
      { category: 'artificial-intelligence', impact_level: 'P3', pending: 1 },
    ]),
    [
      { category: 'consumer-electronics', impact_level: 'P2', pending: 2 },
      { category: 'artificial-intelligence', impact_level: 'P3', pending: 1 },
    ],
  );
});

test('LLM policy disables noisy impact providers while keeping safe briefing fallback caps', () => {
  assert.equal(llmProviderEnabled({
    provider: 'github',
    model: 'openai/gpt-4.1-mini',
    operation: 'impact_scoring',
  }), false);
  assert.equal(llmProviderEnabled({
    provider: 'github',
    model: 'meta/meta-llama-3.1-8b-instruct',
    operation: 'briefing_generation',
  }), true);
  assert.equal(maxBatchSizeForLlmProvider({
    provider: 'github',
    model: 'meta/meta-llama-3.1-8b-instruct',
    operation: 'briefing_generation',
  }), 1);
  assert.equal(llmProviderEnabled({
    provider: 'llmrack',
    model: 'qwen-2.5-7b',
    operation: 'briefing_generation',
  }), false);
});

test('ops health separates active provider cooldowns from historical disabled cooldowns', () => {
  const policies = [
    { operation: 'impact_scoring', provider: 'nvidia', model: 'openai/gpt-oss-120b', enabled: true },
    { operation: 'impact_scoring', provider: 'cloudflare', model: '@cf/openai/gpt-oss-120b', enabled: false },
  ];
  const cooldowns = splitCooldownRows([
    { operation: 'impact_scoring', provider: 'nvidia', model: 'openai/gpt-oss-120b' },
    { operation: 'impact_scoring', provider: 'cloudflare', model: '@cf/openai/gpt-oss-120b' },
    { operation: 'briefing_generation', provider: 'old-provider', model: 'old-model' },
  ], policies);

  assert.equal(cooldowns.active.length, 1);
  assert.equal(cooldowns.inactiveHistorical.length, 2);
  assert.equal(cooldowns.inactiveHistorical[0].enabled, false);

  const providerRows = splitProviderRows([
    { operation: 'impact_scoring', provider: 'nvidia', requested_model: 'openai/gpt-oss-120b' },
    { operation: 'impact_scoring', provider: 'cloudflare', requested_model: '@cf/openai/gpt-oss-120b' },
  ], policies);
  assert.deepEqual(providerRows.map((row) => row.enabled), [true, false]);
});

test('briefing worker keeps useful free-provider batch size when unbounded providers are available', () => {
  assert.equal(batchSizeForBriefingProviders([
    { provider: 'mistral', model: 'mistral-small-latest' },
    { provider: 'github', model: 'meta/meta-llama-3.1-8b-instruct' },
    { provider: 'openai', model: 'gpt-5-nano' },
  ]), 5);

  assert.equal(batchSizeForBriefingProviders([
    { provider: 'github', model: 'meta/meta-llama-3.1-8b-instruct' },
    { provider: 'openrouter', model: 'openai/gpt-oss-120b:free' },
    { provider: 'openai', model: 'gpt-5-nano' },
  ]), 1);
});

test('model JSON parsing accepts wrapped JSON but rejects empty invalid responses', () => {
  assert.deepEqual(parseJsonObject('prefix {"ok": true, "items": [1]} suffix'), {
    ok: true,
    items: [1],
  });
  assert.throws(() => parseJsonObject('no structured payload'), /Model response did not contain JSON object/);
});

test('Mattermost destinations are de-duplicated before posting', () => {
  assert.deepEqual(
    mattermostDestinations().map((destination) => ({
      categorySlug: destination.categorySlug,
      channel: destination.channel,
    })),
    [
      { categorySlug: 'artificial-intelligence', channel: 'news-ai' },
      { categorySlug: 'cloud-infrastructure', channel: 'news-cloud' },
    ],
  );
});

test('superseded Mattermost records do not count as active failures', () => {
  assert.deepEqual(mattermostFailureRows([
    { status: 'posted', notifications: 1 },
    { status: 'superseded', notifications: 17 },
    { status: 'failed', notifications: 1 },
  ]), [
    { status: 'failed', notifications: 1 },
  ]);
});
