import { getAuthSession, getTrustedDevice } from './auth.js';
import { handleAuthRoutes } from './api/authRoutes.js';
import { handleRecordRoutes } from './api/recordRoutes.js';
import { handleDoseRoutes } from './api/doseRoutes.js';
import { handlePhotoRoutes } from './api/photoRoutes.js';
import { handleAIRoutes } from './api/aiRoutes.js';
import { getFallbackHtml } from './fallbackHtml.js';

const ALLOWED_EXTERNAL_ORIGINS = new Set(['https://walking-scr.github.io']);

function isAllowedOrigin(origin, request) {
  if (!origin) return false;
  if (origin === 'null' || origin.startsWith('file://')) return true;
  try {
    return origin === new URL(request.url).origin || ALLOWED_EXTERNAL_ORIGINS.has(origin);
  } catch {
    return false;
  }
}

function addSecurityHeaders(response, request = null) {
  const newHeaders = new Headers(response.headers);
  newHeaders.set('X-Content-Type-Options', 'nosniff');
  newHeaders.set('X-Frame-Options', 'DENY');
  newHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (request) {
    const origin = request.headers.get('Origin');
    if (isAllowedOrigin(origin, request)) {
      newHeaders.set('Access-Control-Allow-Origin', origin);
      newHeaders.set('Access-Control-Allow-Credentials', 'true');
      newHeaders.append('Vary', 'Origin');
    }
  }

  const contentType = newHeaders.get('Content-Type') || '';
  const reqUrl = request ? new URL(request.url).pathname : '';
  if (contentType.includes('text/html') || reqUrl.endsWith('sw.js') || reqUrl.endsWith('manifest.json')) {
    newHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    newHeaders.set('Pragma', 'no-cache');
    newHeaders.set('Expires', '0');
  }

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

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin');
      const corsHeaders = {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Token, X-GitHub-Token',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin'
      };
      if (isAllowedOrigin(origin, request)) corsHeaders['Access-Control-Allow-Origin'] = origin;
      return new Response(null, {
        headers: corsHeaders
      });
    }

    // Check all possible token environment variables
    const serverToken = (
      (env.GITHUB_TOKEN && env.GITHUB_TOKEN.trim()) ||
      (env.GITHUB_PAT && env.GITHUB_PAT.trim()) ||
      (env.GH_TOKEN && env.GH_TOKEN.trim()) ||
      (env.PAT && env.PAT.trim()) ||
      (env.TOKEN && env.TOKEN.trim()) ||
      (env.GITHUB_DATA_TOKEN && env.GITHUB_DATA_TOKEN.trim()) ||
      ''
    );
    const clientToken = request.headers.get('X-GitHub-Token');
    const effectiveToken = serverToken || (clientToken ? clientToken.trim() : '');
    const reqEnv = { ...env, GITHUB_TOKEN: effectiveToken };

    // 1. CSRF Protection for state-modifying API requests
    if (['POST', 'PATCH', 'DELETE'].includes(request.method) && path.startsWith('/api/')) {
      const origin = request.headers.get('Origin');
      if (origin && origin !== 'null' && !origin.startsWith('file://')) {
        try {
          const originUrl = new URL(origin);
          if (originUrl.host !== url.host && !ALLOWED_EXTERNAL_ORIGINS.has(origin) && !originUrl.host.includes('localhost') && !originUrl.host.includes('127.0.0.1')) {
            return new Response(JSON.stringify({ error: 'CSRF_BLOCKED', message: '非法跨域请求' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        } catch (e) {
          // Invalid URL in origin header, ignore
        }
      }
    }

    // 2. Auth Routes (/api/auth/*)
    if (path.startsWith('/api/auth/')) {
      const authRes = await handleAuthRoutes(request, reqEnv, url);
      if (authRes) return addSecurityHeaders(authRes, request);
    }

    // 3. API Routes (/api/records, /api/doses, /api/photos, /api/ai)
    if (path.startsWith('/api/')) {
      const session = await getAuthSession(request, reqEnv);

      if (path.startsWith('/api/ai/')) {
        const aiRes = await handleAIRoutes(request, reqEnv, url, session);
        if (aiRes) return addSecurityHeaders(aiRes, request);
      }

      // Mutating requests strictly require authentication
      const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
      if (isMutation && !session) {
        return addSecurityHeaders(new Response(JSON.stringify({
          error: 'AUTH_REQUIRED',
          message: '需要受信任设备登录认证后方可修改数据'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        }), request);
      }

      if (path.startsWith('/api/records')) {
        const recordRes = await handleRecordRoutes(request, reqEnv, url, session);
        if (recordRes) return addSecurityHeaders(recordRes, request);
      }

      if (path.startsWith('/api/doses')) {
        const doseRes = await handleDoseRoutes(request, reqEnv, url, session);
        if (doseRes) return addSecurityHeaders(doseRes, request);
      }

      if (path.startsWith('/api/photos')) {
        const photoRes = await handlePhotoRoutes(request, reqEnv, url, session);
        if (photoRes) return addSecurityHeaders(photoRes, request);
      }

      return addSecurityHeaders(new Response(JSON.stringify({ error: 'NOT_FOUND' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      }), request);
    }

    // 4. Special alias: /setup opens the app with setup flag
    if (path === '/setup') {
      const session = await getAuthSession(request, reqEnv);
      const device = await getTrustedDevice(request, reqEnv);
      if (session || device) {
        return Response.redirect(`${url.origin}/`, 302);
      }

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
      if (url.searchParams.get('mode') === 'setup') {
        const session = await getAuthSession(request, reqEnv);
        const device = await getTrustedDevice(request, reqEnv);
        if (session || device) {
          return Response.redirect(`${url.origin}/`, 302);
        }
      }

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
