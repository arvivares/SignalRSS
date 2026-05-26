const baseUrl = (process.env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
const model = process.argv[2] || process.env.LOCAL_LLM_MODEL || 'gemma4:e4b';
const timeoutMs = Number(process.env.LOCAL_LLM_PROBE_TIMEOUT_MS || 120000);

const schema = {
  type: 'json_schema',
  json_schema: {
    name: 'signalrss_local_llm_probe',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['impact_level', 'impact_score', 'category', 'summary_es', 'confidence'],
      properties: {
        impact_level: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
        impact_score: { type: 'number', minimum: 0, maximum: 100 },
        category: { type: 'string' },
        summary_es: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
  },
};

const messages = [
  {
    role: 'system',
    content: 'You are a strict JSON generator for a technology news impact scoring pipeline. Return only valid JSON matching the schema.',
  },
  {
    role: 'user',
    content: [
      'Evaluate this technology news cluster for SignalRSS.',
      'Title: Google releases a new open-weight local AI model optimized for laptops.',
      'Summary: The model can run offline on consumer hardware and supports structured JSON outputs for agent workflows.',
      'Return the impact level, numeric impact score, category, Spanish summary, and confidence.',
    ].join('\n'),
  },
];

async function main() {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      authorization: 'Bearer local',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0,
      max_tokens: 700,
      response_format: schema,
      stream: false,
    }),
  });

  const raw = await response.text();
  const elapsedMs = Date.now() - started;
  if (!response.ok) {
    console.error(JSON.stringify({ ok: false, model, elapsedMs, status: response.status, raw: raw.slice(0, 1000) }, null, 2));
    process.exit(1);
  }

  const body = JSON.parse(raw);
  const content = body.choices?.[0]?.message?.content || '';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, model, elapsedMs, error: error.message, content }, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    model,
    resolvedModel: body.model || model,
    elapsedMs,
    usage: body.usage || null,
    parsed,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, model, error: error.message }, null, 2));
  process.exit(1);
});
