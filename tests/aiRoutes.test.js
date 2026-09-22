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
  let sentApiKey = '';
  globalThis.fetch = async (input, init) => {
    calledUrl = String(input);
    sentApiKey = init.headers['x-goog-api-key'];
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
    assert.equal(sentApiKey, 'server-key');
    assert.match(calledUrl, /aiplatform\.googleapis\.com\/v1\/publishers\/google\/models\/[^/]+:generateContent$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('uses MiniMax-M3 as the primary endpoint when MINIMAX_API_KEY is configured', async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl = '';
  let sentAuth = '';
  let sentBody = null;
  globalThis.fetch = async (input, init) => {
    calledUrl = String(input);
    sentAuth = init.headers['Authorization'];
    sentBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"weight":"169.8","unit":"斤","confidence":"high"}' } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const response = await handleAIRoutes(request({ imageBase64 }, { 'X-Request-ID': 'test-minimax-success' }), { MINIMAX_API_KEY: 'mmx-key', GEMINI_API_KEY: 'server-key' }, url);
    const body = await json(response);
    assert.equal(response.status, 200);
    assert.equal(body.weight, 169.8);
    assert.equal(body.model, 'MiniMax-M3');
    assert.equal(calledUrl, 'https://api.minimaxi.com/v1/chat/completions');
    assert.equal(sentAuth, 'Bearer mmx-key');
    assert.equal(sentBody.model, 'MiniMax-M3');
    assert.equal(sentBody.thinking.type, 'disabled');
    const imageBlock = sentBody.messages[0].content.find((block) => block.type === 'image_url');
    assert.match(imageBlock.image_url.url, /^data:image\/jpeg;base64,/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('falls back to Gemini when MiniMax fails', async () => {
  const originalFetch = globalThis.fetch;
  const calledUrls = [];
  globalThis.fetch = async (input) => {
    const target = String(input);
    calledUrls.push(target);
    if (target.includes('api.minimaxi.com')) {
      return new Response(JSON.stringify({ error: { message: 'insufficient balance' } }), { status: 402 });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"weight":171.2,"unit":"斤"}' }] } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const response = await handleAIRoutes(request({ imageBase64 }), { MINIMAX_API_KEY: 'mmx-key', GEMINI_API_KEY: 'server-key' }, url);
    const body = await json(response);
    assert.equal(response.status, 200);
    assert.equal(body.weight, 171.2);
    assert.equal(calledUrls[0].includes('api.minimaxi.com'), true);
    assert.equal(calledUrls.at(-1).includes('aiplatform.googleapis.com'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('skips MiniMax for HEIC passthrough and sends it to Gemini directly', async () => {
  const originalFetch = globalThis.fetch;
  let firstCalledUrl = '';
  let firstSentMime = '';
  globalThis.fetch = async (input, init) => {
    if (!firstCalledUrl) {
      firstCalledUrl = String(input);
      const payload = JSON.parse(init.body);
      firstSentMime = payload.contents[0].parts[1].inlineData.mimeType;
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"weight":169.5,"unit":"斤","confidence":"high"}' }] } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const response = await handleAIRoutes(request({ imageBase64: imageBase64.replace('image/jpeg', 'image/heic') }), { MINIMAX_API_KEY: 'mmx-key', GEMINI_API_KEY: 'server-key' }, url);
    const body = await json(response);
    assert.equal(response.status, 200);
    assert.equal(body.weight, 169.5);
    assert.equal(firstCalledUrl.includes('aiplatform.googleapis.com'), true);
    assert.equal(firstSentMime, 'image/heic');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('falls back to the public Gemini endpoint when Vertex rejects the model', async () => {
  const originalFetch = globalThis.fetch;
  const calledUrls = [];
  globalThis.fetch = async (input) => {
    const target = String(input);
    calledUrls.push(target);
    if (target.includes('aiplatform.googleapis.com')) {
      return new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"weight":171.2,"unit":"斤"}' }] } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const response = await handleAIRoutes(request({ imageBase64 }), { GEMINI_API_KEY: 'server-key' }, url);
    const body = await json(response);
    assert.equal(response.status, 200);
    assert.equal(body.weight, 171.2);
    assert.ok(calledUrls[0].includes('aiplatform.googleapis.com'));
    assert.ok(calledUrls.at(-1).includes('generativelanguage.googleapis.com'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('maps upstream geo-block rejections to AI_REGION_BLOCKED instead of an image error', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response(JSON.stringify({
      error: { message: 'User location is not supported for the API use.' }
    }), { status: 400 });
  };

  try {
    const response = await handleAIRoutes(request({ imageBase64 }, { 'X-Request-ID': 'test-geo-blocked' }), { GEMINI_API_KEY: 'server-key' }, url);
    const body = await json(response);
    assert.equal(response.status, 502);
    assert.equal(body.error, 'AI_REGION_BLOCKED');
    assert.match(body.message, /网络/);
    assert.equal(attempts, 4); // both models on both endpoints
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('limits generation output for minimum latency', async () => {
  const originalFetch = globalThis.fetch;
  let sentConfig = null;
  globalThis.fetch = async (_input, init) => {
    const payload = JSON.parse(init.body);
    sentConfig = payload.generationConfig;
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"weight":172.0,"unit":"斤"}' }] } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const response = await handleAIRoutes(request({ imageBase64 }), { GEMINI_API_KEY: 'server-key' }, url);
    assert.equal(response.status, 200);
    assert.equal(sentConfig.temperature, 0);
    assert.equal(sentConfig.maxOutputTokens, 32);
    assert.equal(sentConfig.thinkingConfig, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('passes raw HEIC images through when browser conversion is unavailable', async () => {
  const originalFetch = globalThis.fetch;
  let sentMimeType = '';
  globalThis.fetch = async (_input, init) => {
    const payload = JSON.parse(init.body);
    sentMimeType = payload.contents[0].parts[1].inlineData.mimeType;
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"weight":169.5,"unit":"斤","confidence":"high"}' }] } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const response = await handleAIRoutes(request({ imageBase64: imageBase64.replace('image/jpeg', 'image/heic') }), { GEMINI_API_KEY: 'server-key' }, url);
    const body = await json(response);
    assert.equal(response.status, 200);
    assert.equal(body.weight, 169.5);
    assert.equal(sentMimeType, 'image/heic');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('maps Gemini authentication failures to an actionable error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'unauthorized' } }), { status: 401 });
  try {
    const response = await handleAIRoutes(request({ imageBase64 }, { 'X-Request-ID': 'test-auth-failure' }), { GEMINI_API_KEY: 'server-key' }, url);
    const body = await json(response);
    assert.equal(response.status, 502);
    assert.equal(body.error, 'AI_AUTH_FAILED');
    assert.equal(body.message, 'unauthorized');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
