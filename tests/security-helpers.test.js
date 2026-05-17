import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { redactSecrets } from '../src/log-utils.js';
import { readJsonBody } from '../src/request-utils.js';

function requestFromBody(body, headers = { 'content-type': 'application/json' }) {
  const stream = Readable.from([body]);
  stream.headers = headers;
  return stream;
}

test('redactSecrets removes common provider tokens and query secrets', () => {
  const openAiKey = `sk-proj-${'abcdefghijklmnopqrstuvwxyz123456'}`;
  const groqKey = `gsk_${'abcdefghijklmnopqrstuvwxyz123456'}`;
  const githubToken = `github_pat_${'11AEEKRGI0exampletokenvalue'}`;
  const input = [
    `Authorization: Bearer ${openAiKey}`,
    `groq=${groqKey}`,
    'url=https://x.test/?api_key=abcdef1234567890&ok=1',
    githubToken,
  ].join('\n');

  const output = redactSecrets(input);
  assert.equal(output.includes(openAiKey), false);
  assert.equal(output.includes(groqKey), false);
  assert.equal(output.includes('abcdef1234567890'), false);
  assert.equal(output.includes(githubToken), false);
  assert.match(output, /\[REDACTED\]/);
});

test('readJsonBody rejects unsupported content type', async () => {
  await assert.rejects(
    () => readJsonBody(requestFromBody('{}', { 'content-type': 'text/plain' })),
    /Unsupported content type/,
  );
});

test('readJsonBody rejects malformed JSON as bad request', async () => {
  await assert.rejects(
    () => readJsonBody(requestFromBody('{')),
    (error) => error.statusCode === 400 && /Invalid JSON body/.test(error.message),
  );
});

test('readJsonBody enforces byte limits', async () => {
  await assert.rejects(
    () => readJsonBody(requestFromBody('{"x":"123456"}'), { maxBytes: 5 }),
    (error) => error.statusCode === 413 && /too large/i.test(error.message),
  );
});
