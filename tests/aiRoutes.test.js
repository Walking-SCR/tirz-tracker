import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAIRoutes } from '../src/api/aiRoutes.js';

const url = new URL('https://example.com/api/ai/analyze-scale');
const imageBase64 = `data:image/jpeg;base64,${'A'.repeat(160)}`;

function request(body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

async function json(response) {
  return response.json();
}

test('rejects invalid JSON with a traceable error code', async () => {
  const response = await handleAIRoutes(new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'test-invalid-json' },
    body: '{'
  }), {}, url);

  assert.equal(response.status, 400);
  assert.deepEqual(await json(response), {
    error: 'INVALID_JSON',
    message: '请求格式不合法',
    requestId: 'test-invalid-json'
  });
});

test('rejects requests without an image', async () => {
  const response = await handleAIRoutes(request({}), {}, url);
  const body = await json(response);
  assert.equal(response.status, 400);
  assert.equal(body.error, 'MISSING_IMAGE');
  assert.ok(body.requestId);
});

test('does not accept a browser-supplied key when the Worker Secret is missing', async () => {
  const response = await handleAIRoutes(request({ imageBase64, apiKey: 'browser-key' }), {}, url);
  const body = await json(response);
  assert.equal(response.status, 503);
  assert.equal(body.error, 'AI_NOT_CONFIGURED');
});

test('rejects unsupported image types before calling Gemini', async () => {
  const response = await handleAIRoutes(request({ imageBase64: imageBase64.replace('image/jpeg', 'text/plain') }), { GEMINI_API_KEY: 'server-key' }, url);
  const body = await json(response);
  assert.equal(response.status, 415);
  assert.equal(body.error, 'UNSUPPORTED_IMAGE_TYPE');
});

test('returns the normalized weight from the Gemini response', async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl = '';
  globalThis.fetch = async (input) => {
    calledUrl = String(input);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"weight":"170.3","unit":"斤","confidence":"high"}' }] } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const response = await handleAIRoutes(request({ imageBase64, apiKey: 'ignored-browser-key' }, { 'X-Request-ID': 'test-success' }), { GEMINI_API_KEY: 'server-key' }, url);
    const body = await json(response);
    assert.equal(response.status, 200);
    assert.equal(body.weight, 170.3);
    assert.equal(body.requestId, 'test-success');
    assert.match(calledUrl, /key=server-key$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
