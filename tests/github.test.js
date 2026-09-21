import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadPhoto } from '../src/github.js';

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
