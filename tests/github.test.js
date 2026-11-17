import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadPhoto, fetchPrivatePhoto, mutateRecordsWithRetry } from '../src/github.js';
import { getFallbackHtml } from '../src/fallbackHtml.js';

test('uploads JPEG bytes with a JPEG file extension', async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl = '';
  let requestBody = null;
  globalThis.fetch = async (input, init) => {
    calledUrl = String(input);
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ content: { sha: 'sha-test' } }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const result = await uploadPhoto(
      { GITHUB_TOKEN: 'server-token', GITHUB_OWNER: 'Walking-SCR', GITHUB_DATA_REPO: 'tirz-tracker-data', GITHUB_BRANCH: 'main' },
      '2026',
      '09',
      'wt-test.webp',
      'data:image/jpeg;base64,QUJD'
    );
    assert.match(calledUrl, /\/images\/2026\/09\/wt-test\.jpg$/);
    assert.equal(requestBody.content, 'QUJD');
    assert.equal(result.path, 'images/2026/09/wt-test.jpg');
    assert.equal(result.sha, 'sha-test');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchPrivatePhoto streams raw binary responses directly without 1MB Base64 truncation', async () => {
  const originalFetch = globalThis.fetch;
  let sentAccept = '';
  const rawBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  globalThis.fetch = async (_input, init) => {
    sentAccept = init.headers.Accept;
    return new Response(rawBytes, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' }
    });
  };

  try {
    const photo = await fetchPrivatePhoto({ GITHUB_TOKEN: 'tok' }, 'images/health/2026/10/lab-large.png');
    assert.equal(sentAccept, 'application/vnd.github.raw+json');
    assert.equal(photo.contentType, 'image/png');
    assert.deepEqual(Array.from(photo.body), Array.from(rawBytes));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('mutateRecordsWithRetry re-reads and merges on GitHub 409 conflict instead of overwriting concurrent writes', async () => {
  const originalFetch = globalThis.fetch;
  let putCount = 0;
  let finalSaved = null;

  globalThis.fetch = async (_input, init = {}) => {
    if (init.method === 'PUT') {
      putCount += 1;
      const body = JSON.parse(init.body);
      if (putCount === 1) {
        assert.equal(body.sha, 'sha-v1');
        return new Response(JSON.stringify({ message: 'Conflict' }), { status: 409 });
      }
      assert.equal(body.sha, 'sha-v2');
      finalSaved = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      return new Response(JSON.stringify({ content: { sha: 'sha-v3' } }), { status: 200 });
    }
    // Concurrent write added 'wt-concurrent' on sha-v2 while first PUT was in flight
    const serverState = {
      version: '2.0',
      weights: [{ id: 'wt-concurrent', weight: 166.2, timestamp: 200 }]
    };
    return new Response(JSON.stringify({
      sha: 'sha-v2',
      content: Buffer.from(JSON.stringify(serverState)).toString('base64')
    }), { status: 200 });
  };

  try {
    const staleSnapshot = {
      records: [],
      sha: 'sha-v1',
      rawParsed: { version: '2.0', weights: [] }
    };
    await mutateRecordsWithRetry({ GITHUB_TOKEN: 'tok' }, (records) => {
      records.unshift({ id: 'wt-new', weight: 165.8, timestamp: 300 });
      return { records };
    }, 'Add record', staleSnapshot);

    assert.equal(putCount, 2);
    assert.deepEqual(finalSaved.weights.map(w => w.id), ['wt-new', 'wt-concurrent']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getFallbackHtml works in pure Web runtime without global Node Buffer', () => {
  const originalBuffer = globalThis.Buffer;
  try {
    globalThis.Buffer = undefined;
    const html = getFallbackHtml();
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('体重记录'));
  } finally {
    globalThis.Buffer = originalBuffer;
  }
});
