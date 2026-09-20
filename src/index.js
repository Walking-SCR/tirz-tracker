import { getAuthSession } from './auth.js';
import { handleAuthRoutes } from './api/authRoutes.js';
import { handleRecordRoutes } from './api/recordRoutes.js';
import { handleDoseRoutes } from './api/doseRoutes.js';
import { handlePhotoRoutes } from './api/photoRoutes.js';

function addSecurityHeaders(response) {
  const newHeaders = new Headers(response.headers);
  newHeaders.set('X-Content-Type-Options', 'nosniff');
  newHeaders.set('X-Frame-Options', 'DENY');
  newHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. CSRF Protection for state-modifying API requests
    if (['POST', 'PATCH', 'DELETE'].includes(request.method) && path.startsWith('/api/')) {
      const origin = request.headers.get('Origin');
      if (origin) {
        const originUrl = new URL(origin);
        if (originUrl.host !== url.host) {
          return new Response(JSON.stringify({ error: 'CSRF_BLOCKED', message: '非法跨域请求' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    }

    // 2. Auth Routes (/api/auth/*)
    if (path.startsWith('/api/auth/')) {
      const authRes = await handleAuthRoutes(request, env, url);
      if (authRes) return addSecurityHeaders(authRes);
    }

    // 3. Protected API Routes (/api/records, /api/doses, /api/photos)
    if (path.startsWith('/api/')) {
      const session = await getAuthSession(request, env);
      if (!session) {
        return addSecurityHeaders(new Response(JSON.stringify({
          error: 'AUTH_REQUIRED',
          message: '需要登录认证或会话已过期'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      if (path.startsWith('/api/records')) {
        const recordRes = await handleRecordRoutes(request, env, url, session);
        if (recordRes) return addSecurityHeaders(recordRes);
      }

      if (path.startsWith('/api/doses')) {
        const doseRes = await handleDoseRoutes(request, env, url, session);
        if (doseRes) return addSecurityHeaders(doseRes);
      }

      if (path.startsWith('/api/photos')) {
        const photoRes = await handlePhotoRoutes(request, env, url, session);
        if (photoRes) return addSecurityHeaders(photoRes);
      }

      return addSecurityHeaders(new Response(JSON.stringify({ error: 'NOT_FOUND' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      }));
    }

    // 4. Special alias: /setup opens the app with setup flag
    if (path === '/setup') {
      if (env.ASSETS) {
        const assetUrl = new URL('/index.html', request.url);
        assetUrl.searchParams.set('mode', 'setup');
        return addSecurityHeaders(await env.ASSETS.fetch(new Request(assetUrl, request)));
      }
    }

    // 5. Static Assets fallback (Worker Static Assets via env.ASSETS)
    if (env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(request);
      return addSecurityHeaders(assetRes);
    }

    return new Response('Tirz Tracker Worker Ready (Static Assets not bound in local test)', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
};
