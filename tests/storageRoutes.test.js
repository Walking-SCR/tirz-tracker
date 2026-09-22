import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRecordRoutes } from '../src/api/recordRoutes.js';
import { handleDoseRoutes } from '../src/api/doseRoutes.js';
import { handlePhotoRoutes } from '../src/api/photoRoutes.js';

test('GET /api/records returns 503 when GITHUB_TOKEN is not configured', async () => {
  const req = new Request('https://tracker.test/api/records', { method: 'GET' });
  const env = {};
  const url = new URL(req.url);
  const res = await handleRecordRoutes(req, env, url, null);

  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.error, 'STORAGE_NOT_CONFIGURED');
});

test('POST /api/records returns 503 when GITHUB_TOKEN is not configured', async () => {
  const req = new Request('https://tracker.test/api/records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ weight: 168.5, date: '2026-09-21' })
  });
  const env = {};
  const url = new URL(req.url);
  const res = await handleRecordRoutes(req, env, url, null);

  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.error, 'STORAGE_NOT_CONFIGURED');
});

test('GET /api/records returns records from GitHub without static asset fallback', async () => {
  const originalFetch = globalThis.fetch;
  const mockRecords = [
    { id: 'wt-1', weight: 168.0, date: '2026-09-21', condition: '早上空腹' }
  ];
  const b64 = Buffer.from(JSON.stringify({ weights: mockRecords })).toString('base64');

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/contents/data/records.json')) {
      return new Response(JSON.stringify({ content: b64, sha: 'sha-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Not found', { status: 404 });
  };

  try {
    const req = new Request('https://tracker.test/api/records', { method: 'GET' });
    const env = { GITHUB_TOKEN: 'fake-token' };
    const url = new URL(req.url);
    const res = await handleRecordRoutes(req, env, url, null);

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].id, 'wt-1');
    assert.equal(data[0].weight, 168.0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET /api/doses returns 503 when GITHUB_TOKEN is not configured', async () => {
  const req = new Request('https://tracker.test/api/doses', { method: 'GET' });
  const env = {};
  const url = new URL(req.url);
  const res = await handleDoseRoutes(req, env, url, null);

  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.error, 'STORAGE_NOT_CONFIGURED');
});

test('GET /api/doses returns doses from GitHub without static fallback', async () => {
  const originalFetch = globalThis.fetch;
  const mockDoses = [{ id: 'dose-1', seq: '第一针', amount: '2.5ml' }];
  const b64 = Buffer.from(JSON.stringify(mockDoses)).toString('base64');

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/contents/data/doses.json')) {
      return new Response(JSON.stringify({ content: b64, sha: 'sha-2' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Not found', { status: 404 });
  };

  try {
    const req = new Request('https://tracker.test/api/doses', { method: 'GET' });
    const env = { GITHUB_TOKEN: 'fake-token' };
    const url = new URL(req.url);
    const res = await handleDoseRoutes(req, env, url, null);

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].id, 'dose-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET /api/photos/... returns 503 when GITHUB_TOKEN is not configured', async () => {
  const req = new Request('https://tracker.test/api/photos/2026/09/wt-123456.jpg', { method: 'GET' });
  const env = {};
  const url = new URL(req.url);
  const res = await handlePhotoRoutes(req, env, url, null);

  assert.equal(res.status, 503);
});

test('GET /api/photos/... fetches private photo from GitHub repo', async () => {
  const originalFetch = globalThis.fetch;
  const b64 = Buffer.from('FAKE_IMAGE_BYTES').toString('base64');

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/contents/images/2026/09/wt-test.jpg')) {
      return new Response(JSON.stringify({ content: b64, sha: 'sha-img' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Not found', { status: 404 });
  };

  try {
    const req = new Request('https://tracker.test/api/photos/2026/09/wt-test.jpg', { method: 'GET' });
    const env = { GITHUB_TOKEN: 'fake-token' };
    const url = new URL(req.url);
    const res = await handlePhotoRoutes(req, env, url, null);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
    const arrayBuffer = await res.arrayBuffer();
    const str = Buffer.from(arrayBuffer).toString();
    assert.equal(str, 'FAKE_IMAGE_BYTES');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('PATCH /api/doses/:id updates dose fields and recomputes timestamp', async () => {
  const originalFetch = globalThis.fetch;
  const mockDoses = [
    { id: 'dose-1', seq: '第一针', amount: '2.5mg', date: '2026-09-12', time: '20:00', intervalDays: 7 }
  ];
  const b64 = Buffer.from(JSON.stringify(mockDoses)).toString('base64');
  let putBody = null;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/contents/data/doses.json')) {
      if (init && init.method === 'PUT') {
        putBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ content: { sha: 'sha-3' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ content: b64, sha: 'sha-2' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Not found', { status: 404 });
  };

  try {
    const req = new Request('https://tracker.test/api/doses/dose-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: '5.0mg', intervalDays: 14, date: '2026-09-19', time: '21:00' })
    });
    const env = { GITHUB_TOKEN: 'fake-token' };
    const url = new URL(req.url);
    const res = await handleDoseRoutes(req, env, url, null);

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.dose.amount, '5.0mg');
    assert.equal(data.dose.intervalDays, 14);
    assert.equal(data.dose.date, '2026-09-19');
    assert.equal(data.dose.timestamp, new Date('2026-09-19T21:00:00').getTime());
    assert.ok(putBody);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('PATCH /api/records/:id updates fields and recomputes timestamp', async () => {
  const originalFetch = globalThis.fetch;
  const mockRecords = [
    { id: 'wt-1', weight: 168.0, date: '2026-09-20', time: '08:00', timestamp: 1000 }
  ];
  const b64 = Buffer.from(JSON.stringify(mockRecords)).toString('base64');
  let putBody = null;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/contents/data/records.json')) {
      if (init && init.method === 'PUT') {
        putBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ content: { sha: 'sha-rec-2' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ content: b64, sha: 'sha-rec-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Not found', { status: 404 });
  };

  try {
    const req = new Request('https://tracker.test/api/records/wt-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weight: 167.2, date: '2026-09-22', time: '08:30', condition: '早餐后' })
    });
    const env = { GITHUB_TOKEN: 'fake-token' };
    const url = new URL(req.url);
    const res = await handleRecordRoutes(req, env, url, null);

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.record.weight, 167.2);
    assert.equal(data.record.condition, '早餐后');
    assert.equal(data.record.timestamp, new Date('2026-09-22T08:30:00').getTime());
    assert.ok(putBody);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
