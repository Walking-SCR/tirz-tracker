import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const allowedOrigin = 'null';

test('auth preflight accepts the null origin used by file:// pages', async () => {
  const request = new Request('https://tracker.test/api/auth/login', {
    method: 'OPTIONS',
    headers: {
      Origin: allowedOrigin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type'
    }
  });

  const response = await worker.fetch(request, {}, {});

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true');
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /Content-Type/i);
});

test('auth routes report missing signing secret as a CORS-readable 503', async () => {
  const request = new Request('https://tracker.test/api/auth/status', {
    headers: { Origin: allowedOrigin }
  });

  const response = await worker.fetch(request, { ALLOWED_EMAIL: 'walkingscr@gmail.com' }, {});
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin);
  assert.equal(body.error, 'AUTH_NOT_CONFIGURED');
  assert.match(body.message, /AUTH_SIGNING_KEY/);
});

test('login without signing secret returns a CORS-readable configuration error, not a network-shaped failure', async () => {
  const request = new Request('https://tracker.test/api/auth/login', {
    method: 'POST',
    headers: {
      Origin: allowedOrigin,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email: 'walkingscr@gmail.com' })
  });

  const response = await worker.fetch(request, { ALLOWED_EMAIL: 'walkingscr@gmail.com' }, {});
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin);
  assert.equal(body.error, 'AUTH_NOT_CONFIGURED');
});
