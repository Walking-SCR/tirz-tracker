import { getAuthSession } from './auth.js';
import { handleAuthRoutes } from './api/authRoutes.js';
import { handleRecordRoutes } from './api/recordRoutes.js';
import { handleDoseRoutes } from './api/doseRoutes.js';
import { handlePhotoRoutes } from './api/photoRoutes.js';
import { getFallbackHtml } from './fallbackHtml.js';

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
        // Allow public baseline scale photos from static assets even before device binding
        if (path.startsWith('/api/photos/') && env.ASSETS) {
          const photoMatch = path.match(/^\/api\/photos\/(?:images\/)?(\d{4})\/(\d{2})\/([a-zA-Z0-9_.-]+)$/);
          if (photoMatch) {
            const [, yyyy, mm, filename] = photoMatch;
            try {
              const assetRes = await env.ASSETS.fetch(new Request(new URL(`/images/${yyyy}/${mm}/${filename}`, request.url)));
              if (assetRes && assetRes.status < 400) {
                return addSecurityHeaders(assetRes);
              }
            } catch (e) {}
          }
        }

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
        try {
          const assetUrl = new URL('/index.html', request.url);
          assetUrl.searchParams.set('mode', 'setup');
          const res = await env.ASSETS.fetch(new Request(assetUrl, request));
          if (res.status === 200) return addSecurityHeaders(res);
        } catch (e) {}
      }
      return Response.redirect(`${url.origin}/?mode=setup`, 302);
    }

    // 5. Root & Static Assets fallback
    if (path === '/' || path === '/index.html') {
      if (env.ASSETS) {
        try {
          const res = await env.ASSETS.fetch(request);
          if (res.status === 200) return addSecurityHeaders(res);
        } catch (e) {}
      }
      return addSecurityHeaders(new Response(getFallbackHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      }));
    }

    if (env.ASSETS) {
      try {
        const assetRes = await env.ASSETS.fetch(request);
        if (assetRes.status !== 404) return addSecurityHeaders(assetRes);
      } catch (e) {}
    }

    // For any remaining HTML navigation, return SPA fallback
    const accept = request.headers.get('Accept') || '';
    if (accept.includes('text/html')) {
      return addSecurityHeaders(new Response(getFallbackHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      }));
    }

    return new Response('Not Found', { status: 404 });
  }
};
