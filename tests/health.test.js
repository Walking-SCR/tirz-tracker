import test from 'node:test';
import assert from 'node:assert/strict';
import { handleHealthRoutes } from '../src/api/healthRoutes.js';
import { buildHealthCalendar, createEmptyHealthDocument, signHealthCalendarVersion, sourceOrderObservations, chronologicalObservations } from '../src/health.js';

const session = { email: 'owner@example.test', deviceId: 'device-1', type: 'session' };
const baseUrl = 'https://tracker.test/api/health';
const signingKey = 'local-test-signing-key-not-a-production-secret';
const token = { GITHUB_TOKEN: 'fake-token', GEMINI_API_KEY: 'fake-gemini-key', AUTH_SIGNING_KEY: signingKey };

test('real health API accepts both frontend arrays and legacy keyed plans and reports configured calendars', async () => {
  const originalFetch = globalThis.fetch;
  const plans = [
    { id: 'oral', times: ['08:10', '13:20', '20:30'], startDate: '2025-05-10' },
    { id: 'topical', times: ['21:40'], startDate: '2025-05-09' },
    { id: 'nail-lacquer', intervalDays: 3, time: '22:10', startDate: '2025-05-09' }
  ];
  try {
    for (const input of [plans, Object.fromEntries(plans.map(plan => [plan.id, plan]))]) {
      let stored = createEmptyHealthDocument();
      stored.revision = 3;
      stored.reports = [{ id: 'keep-existing-report', observations: [] }];
      globalThis.fetch = async (_url, init = {}) => {
        if (init.method === 'PUT') {
          stored = JSON.parse(Buffer.from(JSON.parse(init.body).content, 'base64').toString('utf8'));
          return new Response(JSON.stringify({ content: { sha: 'new-sha' } }), { status: 200 });
        }
        return new Response(JSON.stringify(githubFile(stored)), { status: 200 });
      };
      const response = await handleHealthRoutes(request('/api/health', 'PUT', {
        action: 'save-plans', expectedRevision: 3, medicationPlans: input
      }), token, new URL(baseUrl), session);
      assert.equal(response.status, 200);
      assert.equal(stored.revision, 4);
      assert.equal(stored.reports[0].id, 'keep-existing-report');
      assert.deepEqual(stored.medicationPlans[0].times, plans[0].times);
      assert.deepEqual(stored.medicationPlans.map(plan => plan.cadence), ['daily-slots', 'daily', 'interval-days']);
      const linkUrl = new URL(baseUrl + '/calendar-link');
      const link = await handleHealthRoutes(new Request(linkUrl), token, linkUrl, session);
      assert.equal((await link.json()).configured, true);
      assert.equal((buildHealthCalendar(stored).match(/BEGIN:VEVENT/g) || []).length, 5);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('duplicate medication ids are rejected without overwriting stored plans', async () => {
  const originalFetch = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = async (_url, init = {}) => {
    if (init.method === 'PUT') writes += 1;
    return new Response(JSON.stringify(githubFile(createEmptyHealthDocument())), { status: 200 });
  };
  try {
    const response = await handleHealthRoutes(request('/api/health', 'PUT', {
      action: 'save-plans', expectedRevision: 0,
      medicationPlans: [{ id: 'oral' }, { id: 'oral' }, { id: 'nail-lacquer' }]
    }), token, new URL(baseUrl), session);
    assert.equal(response.status, 400);
    assert.equal(writes, 0);
  } finally { globalThis.fetch = originalFetch; }
});

function githubFile(content, sha = 'health-sha-1') {
  return { content: Buffer.from(JSON.stringify(content)).toString('base64'), sha };
}

function request(path, method = 'GET', body = undefined) {
  return new Request('https://tracker.test' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
}

test('new private health store starts empty and does not fall back to weight data', async () => {
  const originalFetch = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async input => {
    paths.push(new URL(String(input)).pathname);
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await handleHealthRoutes(request('/api/health'), token, new URL(baseUrl), session);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.reports, []);
    assert.equal(body.indicators.length, 2);
    assert.equal(body.revision, 0);
    assert.deepEqual(paths, ['/repos/Walking-SCR/tirz-tracker-data/contents/data/health.json']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('health endpoints require an authenticated session', async () => {
  const res = await handleHealthRoutes(request('/api/health'), token, new URL(baseUrl), null);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'AUTH_REQUIRED');
});

test('report analysis rejects unsupported files before calling Gemini', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('should not call upstream'); };
  try {
    const res = await handleHealthRoutes(request('/api/health/analyze', 'POST', { imageBase64: 'data:text/plain;base64,' + 'A'.repeat(160) }), token, new URL('https://tracker.test/api/health/analyze'), session);
    assert.equal(res.status, 415);
    assert.equal((await res.json()).error, 'UNSUPPORTED_IMAGE_TYPE');
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OCR returns report date types and values for user confirmation, never auto-saves', async () => {
  const originalFetch = globalThis.fetch;
  let saved = false;
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify({
      dateCandidates: [
        { value: '2026-10-10', type: 'report', rawLabel: '报告时间' },
        { value: '2026-10-08', type: 'specimen', rawLabel: '采血日期' }
      ],
      observations: [
        { metricCode: 'ALT', sourceLabel: '谷丙转氨酶', value: 86, unit: 'U/L', referenceRange: { lower: 9, upper: 50 } },
        { metricCode: 'AST', sourceLabel: '谷草转氨酶', value: 45, unit: 'U/L', referenceRange: { lower: 15, upper: 40 } },
        { metricCode: 'OTHER', value: 1, unit: 'U/L' }
      ]
    }) }] } }]
  }), { status: 200 });
  try {
    const res = await handleHealthRoutes(request('/api/health/analyze', 'POST', { imageBase64: 'data:image/jpeg;base64,' + 'A'.repeat(160) }), token, new URL('https://tracker.test/api/health/analyze'), session);
    const body = await res.json();
    saved ||= res.status === 201;
    assert.equal(res.status, 200);
    assert.equal(body.reviewRequired, true);
    assert.deepEqual(body.extraction.dateCandidates.map(row => row.type), ['report', 'specimen']);
    assert.deepEqual(body.extraction.observations.map(row => row.metricCode), ['ALT', 'AST']);
    assert.equal(body.extraction.observations[0].value, 86);
    assert.equal(body.extraction.observations[1].referenceRange.upper, 40);
    assert.equal(saved, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('health report save uses revision control and preserves each report range', async () => {
  const originalFetch = globalThis.fetch;
  const document = createEmptyHealthDocument();
  document.revision = 4;
  let savedDocument;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/contents/data/health.json') && !init.method) {
      return new Response(JSON.stringify(githubFile(document)), { status: 200 });
    }
    if (url.pathname.endsWith('/contents/data/health.json') && init.method === 'PUT') {
      savedDocument = JSON.parse(Buffer.from(JSON.parse(init.body).content, 'base64').toString());
      return new Response(JSON.stringify({ content: { sha: 'health-sha-2' } }), { status: 201 });
    }
    return new Response('unexpected', { status: 404 });
  };
  try {
    const res = await handleHealthRoutes(request('/api/health/reports', 'POST', {
      expectedRevision: 4,
      report: {
        reportDate: '2026-10-10', examDate: null, dateType: 'report', dateConfirmed: false,
        observations: [
          { metricId: 'alt', sourceLabel: 'ALT', value: 86, unit: 'U/L', referenceRange: { lower: 9, upper: 50 } },
          { metricId: 'ast', sourceLabel: 'AST', value: 45, unit: 'U/L', referenceRange: { lower: 15, upper: 40 } }
        ]
      }
    }), token, new URL('https://tracker.test/api/health/reports'), session);
    assert.equal(res.status, 200);
    assert.equal(savedDocument.revision, 5);
    assert.equal(savedDocument.reports[0].dateConfirmed, false);
    assert.equal(savedDocument.reports[0].observations[1].referenceRange.upper, 40);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('revision conflict refuses a stale calendar or medication update', async () => {
  const originalFetch = globalThis.fetch;
  const document = createEmptyHealthDocument();
  document.revision = 3;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/contents/data/health.json')) return new Response(JSON.stringify(githubFile(document)), { status: 200 });
    return new Response('unexpected', { status: 404 });
  };
  try {
    const res = await handleHealthRoutes(request('/api/health', 'PUT', {
      action: 'save-plans', expectedRevision: 2, medicationPlans: {
        oral: { times: ['08:00', '12:00', '19:00'], startDate: '2026-10-16' },
        topical: { times: ['21:00'], startDate: '2026-10-16' },
        'nail-lacquer': { intervalDays: 3, time: '21:30', startDate: '2026-10-16' }
      }
    }), token, new URL('https://tracker.test/api/health'), session);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'REVISION_CONFLICT');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('iPhone calendar feed is signed, private by unguessable token, and emits three medication cadences', async () => {
  const originalFetch = globalThis.fetch;
  const document = createEmptyHealthDocument();
  document.calendar = { active: true, version: 7, userConfirmedAt: null };
  document.medicationPlans = [
    { id: 'oral', cadence: 'daily-slots', times: ['08:00', '12:30', '19:00'], startDate: '2026-10-16', active: true },
    { id: 'topical', cadence: 'daily', times: ['21:00'], startDate: '2026-10-16', active: true },
    { id: 'nail-lacquer', cadence: 'interval-days', intervalDays: 3, time: '21:30', startDate: '2026-10-16', active: true }
  ];
  globalThis.fetch = async input => {
    if (new URL(String(input)).pathname.endsWith('/contents/data/health.json')) return new Response(JSON.stringify(githubFile(document)), { status: 200 });
    return new Response('unexpected', { status: 404 });
  };
  try {
    const signature = await signHealthCalendarVersion(signingKey, 7);
    const calendarUrl = new URL('https://tracker.test/api/health/calendar.ics?version=7&signature=' + signature);
    const res = await handleHealthRoutes(request('/api/health/calendar.ics?version=7&signature=' + signature), token, calendarUrl, null);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'text/calendar; charset=utf-8');
    assert.equal((text.match(/BEGIN:VEVENT/g) || []).length, 5);
    assert.equal((text.match(/BEGIN:VALARM/g) || []).length, 5);
    assert.match(text, /RRULE:FREQ=DAILY;INTERVAL=3/);
    assert.doesNotMatch(text, /EXDATE:/);
    assert.match(text, /SUMMARY:健康计划待确认/);
    assert.doesNotMatch(text, /(?:SUMMARY|DESCRIPTION):.*(?:ALT|AST|86|45|walkingscr@gmail)/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('calendar feed rejects an invalid signature and revoked versions', async () => {
  const originalFetch = globalThis.fetch;
  let storageReads = 0;
  globalThis.fetch = async input => {
    storageReads += 1;
    const url = new URL(String(input));
    if (url.pathname.endsWith('/contents/data/health.json')) {
      const document = createEmptyHealthDocument();
      document.calendar.version = 9;
      return new Response(JSON.stringify(githubFile(document)), { status: 200 });
    }
    return new Response('unexpected', { status: 404 });
  };
  try {
    const badUrl = new URL('https://tracker.test/api/health/calendar.ics?version=9&signature=' + '0'.repeat(64));
    const bad = await handleHealthRoutes(request('/api/health/calendar.ics?version=9&signature=' + '0'.repeat(64)), token, badUrl, null);
    assert.equal(bad.status, 404);
    assert.equal(storageReads, 0);
    const oldSignature = await signHealthCalendarVersion(signingKey, 8);
    const revokedUrl = new URL('https://tracker.test/api/health/calendar.ics?version=8&signature=' + oldSignature);
    const revoked = await handleHealthRoutes(request('/api/health/calendar.ics?version=8&signature=' + oldSignature), token, revokedUrl, null);
    assert.equal(revoked.status, 410);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('metric deletion requires confirmation and removes only that metric observations', async () => {
  const originalFetch = globalThis.fetch;
  const document = createEmptyHealthDocument();
  document.revision = 1;
  document.reports = [{
    id: 'lab-1', sourceOrder: 1, dateConfirmed: false, observations: [
      { metricId: 'alt', metricCode: 'ALT', value: 86, unit: 'U/L', referenceRange: { lower: 9, upper: 50 } },
      { metricId: 'ast', metricCode: 'AST', value: 45, unit: 'U/L', referenceRange: { lower: 15, upper: 40 } }
    ]
  }];
  let savedDocument;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/contents/data/health.json') && !init.method) return new Response(JSON.stringify(githubFile(document)), { status: 200 });
    if (url.pathname.endsWith('/contents/data/health.json') && init.method === 'PUT') {
      savedDocument = JSON.parse(Buffer.from(JSON.parse(init.body).content, 'base64').toString());
      return new Response(JSON.stringify({ content: { sha: 'health-sha-2' } }), { status: 201 });
    }
    return new Response('unexpected', { status: 404 });
  };
  try {
    const missingConfirm = await handleHealthRoutes(request('/api/health/indicators/alt', 'DELETE', { expectedRevision: 1 }), token, new URL('https://tracker.test/api/health/indicators/alt'), session);
    assert.equal(missingConfirm.status, 400);
    const removed = await handleHealthRoutes(request('/api/health/indicators/alt', 'DELETE', { expectedRevision: 1, confirmDelete: true }), token, new URL('https://tracker.test/api/health/indicators/alt'), session);
    assert.equal(removed.status, 200);
    assert.deepEqual(savedDocument.reports[0].observations.map(row => row.metricCode), ['AST']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('source-order preview is not promoted into a dated chronological trend', () => {
  const document = createEmptyHealthDocument();
  document.reports = [{ sourceOrder: 1, dateConfirmed: false, observations: [{ metricCode: 'ALT', value: 78 }] }];
  assert.equal(sourceOrderObservations(document, 'ALT').length, 1);
  assert.equal(chronologicalObservations(document, 'ALT').length, 0);
});
