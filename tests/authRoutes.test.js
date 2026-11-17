import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { signToken } from '../src/auth.js';

const allowedOrigin = 'null';
const signingKey = 'unit-test-32-byte-hmac-signing-secret-key';
const baseEnv = {
  ALLOWED_EMAIL: 'walkingscr@gmail.com',
  AUTH_SIGNING_KEY: signingKey,
  BOOTSTRAP_SECRET: 'strong-secret-2026',
  BOOTSTRAP_ENABLED: 'true',
  GITHUB_TOKEN: 'fake-gh-token'
};

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
  assert.doesNotMatch(response.headers.get('Access-Control-Allow-Headers'), /X-GitHub-Token/i);
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

test('login rejects unbound devices (email alone cannot mint a session) and never leaks allowed email', async () => {
  const wrongEmailReq = new Request('https://tracker.test/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://tracker.test' },
    body: JSON.stringify({ email: 'attacker@example.com' })
  });
  const wrongRes = await worker.fetch(wrongEmailReq, baseEnv, {});
  const wrongBody = await wrongRes.json();
  assert.equal(wrongRes.status, 401);
  assert.equal(wrongBody.error, 'EMAIL_NOT_ALLOWED');
  assert.doesNotMatch(wrongBody.message, /walkingscr@gmail\.com/);

  const unboundReq = new Request('https://tracker.test/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://tracker.test' },
    body: JSON.stringify({ email: 'walkingscr@gmail.com' })
  });
  const unboundRes = await worker.fetch(unboundReq, baseEnv, {});
  const unboundBody = await unboundRes.json();
  assert.equal(unboundRes.status, 403);
  assert.equal(unboundBody.error, 'DEVICE_NOT_BOUND');
});

test('bootstrap rejects empty secret, default fallback secret, and missing server BOOTSTRAP_SECRET', async () => {
  const noServerSecretRes = await worker.fetch(new Request('https://tracker.test/api/auth/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://tracker.test' },
    body: JSON.stringify({ email: 'walkingscr@gmail.com', bootstrapSecret: 'any' })
  }), { ...baseEnv, BOOTSTRAP_SECRET: '' }, {});
  assert.equal(noServerSecretRes.status, 503);
  assert.equal((await noServerSecretRes.json()).error, 'BOOTSTRAP_NOT_CONFIGURED');

  for (const badSecret of ['', 'tirz2026', 'wrong-secret']) {
    const res = await worker.fetch(new Request('https://tracker.test/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://tracker.test' },
      body: JSON.stringify({ email: 'walkingscr@gmail.com', bootstrapSecret: badSecret })
    }), baseEnv, {});
    const body = await res.json();
    assert.equal(res.status, 401);
    assert.equal(body.error, 'INVALID_BOOTSTRAP_SECRET');
    assert.doesNotMatch(body.message, /tirz2026|strong-secret/);
  }
});

test('bootstrap binds device, logout suppresses auto-heal from device cookie, and re-login restores session', async () => {
  const bootRes = await worker.fetch(new Request('https://tracker.test/api/auth/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://tracker.test' },
    body: JSON.stringify({ email: 'walkingscr@gmail.com', bootstrapSecret: 'strong-secret-2026' })
  }), baseEnv, {});
  const bootBody = await bootRes.json();
  assert.equal(bootRes.status, 200);
  assert.equal(bootBody.email, 'wa***@gmail.com');
  assert.ok(bootBody.deviceToken);
  assert.ok(bootBody.sessionToken);

  // Logout sets tirz_logged_out=1 so device cookie alone does not immediately resurrect session
  const logoutRes = await worker.fetch(new Request('https://tracker.test/api/auth/logout', {
    method: 'POST',
    headers: { Origin: 'https://tracker.test', Cookie: `tirz_device=${encodeURIComponent(bootBody.deviceToken)}` }
  }), baseEnv, {});
  assert.equal(logoutRes.status, 200);
  assert.match(logoutRes.headers.get('Set-Cookie') || '', /tirz_logged_out=1/);

  const statusAfterLogout = await worker.fetch(new Request('https://tracker.test/api/auth/status', {
    headers: { Cookie: `tirz_device=${encodeURIComponent(bootBody.deviceToken)}; tirz_logged_out=1` }
  }), baseEnv, {});
  const statusJson = await statusAfterLogout.json();
  assert.equal(statusJson.authenticated, false);
  assert.equal(statusJson.isDeviceBound, true);

  // Subsequent passwordless email login succeeds because device is bound
  const reloginRes = await worker.fetch(new Request('https://tracker.test/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://tracker.test',
      Cookie: `tirz_device=${encodeURIComponent(bootBody.deviceToken)}; tirz_logged_out=1`
    },
    body: JSON.stringify({ email: 'walkingscr@gmail.com' })
  }), baseEnv, {});
  assert.equal(reloginRes.status, 200);
  assert.equal((await reloginRes.json()).success, true);
});

test('all private data read and AI endpoints enforce session authentication and CSRF protection', async () => {
  for (const [method, path] of [
    ['GET', '/api/records'],
    ['GET', '/api/doses'],
    ['GET', '/api/photos/2026/09/wt-1.jpg'],
    ['POST', '/api/ai/analyze-scale']
  ]) {
    const res = await worker.fetch(new Request(`https://tracker.test${path}`, {
      method,
      headers: { Origin: 'https://tracker.test' }
    }), baseEnv, {});
    assert.equal(res.status, 401, `${method} ${path} must require authentication`);
  }

  // CSRF check blocks PUT /api/health from untrusted origins and evil-localhost lookalikes
  const validSession = await signToken({
    email: 'walkingscr@gmail.com',
    deviceId: 'dev-1',
    type: 'session',
    exp: Math.floor(Date.now() / 1000) + 3600
  }, signingKey);

  for (const badOrigin of ['https://evil.example.com', 'https://evil-localhost.com']) {
    const csrfRes = await worker.fetch(new Request('https://tracker.test/api/health', {
      method: 'PUT',
      headers: {
        Origin: badOrigin,
        Cookie: `tirz_session=${encodeURIComponent(validSession)}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ action: 'confirm-calendar', expectedRevision: 0 })
    }), baseEnv, {});
    assert.equal(csrfRes.status, 403);
    assert.equal((await csrfRes.json()).error, 'CSRF_BLOCKED');
  }

  // Sandboxed iframe CSRF: Origin: null WITH ambient cookies is blocked
  const sandboxedCsrf = await worker.fetch(new Request('https://tracker.test/api/records', {
    method: 'POST',
    headers: {
      Origin: 'null',
      Cookie: `tirz_session=${encodeURIComponent(validSession)}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ weight: 165, date: '2026-09-21' })
  }), baseEnv, {});
  assert.equal(sandboxedCsrf.status, 403);

  // Client-injected X-GitHub-Token header is ignored when server secret is missing
  const spoofedTokenRes = await worker.fetch(new Request('https://tracker.test/api/records', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${validSession}`,
      'X-GitHub-Token': 'ghp_attacker_controlled_repo_token'
    }
  }), { ...baseEnv, GITHUB_TOKEN: '' }, {});
  assert.equal(spoofedTokenRes.status, 503);
  assert.equal((await spoofedTokenRes.json()).error, 'STORAGE_NOT_CONFIGURED');
});
