import { getAuthSession, getTrustedDevice } from './auth.js';
import { handleAuthRoutes } from './api/authRoutes.js';
import { handleRecordRoutes } from './api/recordRoutes.js';
import { handleDoseRoutes } from './api/doseRoutes.js';
import { handlePhotoRoutes } from './api/photoRoutes.js';
import { handleAIRoutes } from './api/aiRoutes.js';
import { handleHealthRoutes } from './api/healthRoutes.js';
import { getFallbackHtml } from './fallbackHtml.js';
import { getEffectiveGithubToken } from './github.js';

const ALLOWED_EXTERNAL_ORIGINS = new Set(['https://walking-scr.github.io']);
const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function isAllowedOrigin(origin, request) {
  if (!origin) return false;
  if (origin === 'null' || origin.startsWith('file://')) return true;
  try {
    const reqOrigin = new URL(request.url).origin;
    if (origin === reqOrigin || ALLOWED_EXTERNAL_ORIGINS.has(origin)) return true;
    const parsedOrigin = new URL(origin);
    return LOCALHOST_HOSTNAMES.has(parsedOrigin.hostname);
  } catch {
    return false;
  }
}

function isCsrfAllowed(request, url) {
  const origin = request.headers.get('Origin');
  if (origin) {
    // 沙箱 iframe 发送的 Origin: null 仅在无 Cookie 凭据（即纯自定义 Header /file:// 场景）时放行，
    // 若浏览器自动携带了 Cookie 则拒绝 Origin: null，防止 sandboxed iframe CSRF。
    if (origin === 'null') {
      const hasCookie = Boolean(request.headers.get('Cookie'));
      const hasExplicitTokenHeader = Boolean(request.headers.get('Authorization') || request.headers.get('X-Device-Token'));
      return !hasCookie || hasExplicitTokenHeader;
    }
    if (origin.startsWith('file://')) return true;
    try {
      const originUrl = new URL(origin);
      return (
        originUrl.origin === url.origin ||
        ALLOWED_EXTERNAL_ORIGINS.has(originUrl.origin) ||
        LOCALHOST_HOSTNAMES.has(originUrl.hostname)
      );
    } catch {
      return false;
    }
  }

  // 若缺失 Origin，回退检查 Sec-Fetch-Site（现代浏览器均会发送）
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
    return false;
  }
  return true;
}

function addSecurityHeaders(response, request = null) {
  const newHeaders = new Headers(response.headers);
  newHeaders.set('X-Content-Type-Options', 'nosniff');
  newHeaders.set('X-Frame-Options', 'DENY');
  newHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  newHeaders.set('Permissions-Policy', 'geolocation=(), microphone=(), payment=(), usb=()');

  if (!newHeaders.has('Content-Security-Policy')) {
    const contentType = newHeaders.get('Content-Type') || '';
    if (contentType.includes('text/html')) {
      newHeaders.set(
        'Content-Security-Policy',
        "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
      );
    } else {
      newHeaders.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    }
  }

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

    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin');
      const corsHeaders = {
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Token, X-Request-ID',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin'
      };
      if (isAllowedOrigin(origin, request)) corsHeaders['Access-Control-Allow-Origin'] = origin;
      return new Response(null, { headers: corsHeaders });
    }

    // 零信任原则：GitHub PAT 仅从服务端环境变量/Secrets 读取，不再接受客户端请求头注入
    const effectiveToken = getEffectiveGithubToken(env);
    const reqEnv = { ...env, GITHUB_TOKEN: effectiveToken };

    // 1. 对所有会改变状态的 API 请求（含 POST / PUT / PATCH / DELETE）做严格 CSRF 防护
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && path.startsWith('/api/')) {
      if (!isCsrfAllowed(request, url)) {
        return addSecurityHeaders(new Response(JSON.stringify({
          error: 'CSRF_BLOCKED',
          message: '非法跨域状态变更请求已被拦截'
        }), {
          status: 403,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        }), request);
      }
    }

    // 2. 认证路由（/api/auth/*）
    if (path.startsWith('/api/auth/')) {
      try {
        const authRes = await handleAuthRoutes(request, reqEnv, url);
        if (authRes) return addSecurityHeaders(authRes, request);
      } catch (error) {
        const missingSigningKey = String(error?.message || '').includes('AUTH_SIGNING_KEY_NOT_CONFIGURED');
        console.error(JSON.stringify({
          event: 'auth_route_failed',
          path,
          error: missingSigningKey ? 'AUTH_SIGNING_KEY_NOT_CONFIGURED' : 'AUTH_ROUTE_ERROR'
        }));
        return addSecurityHeaders(new Response(JSON.stringify({
          error: missingSigningKey ? 'AUTH_NOT_CONFIGURED' : 'AUTH_SERVICE_ERROR',
          message: missingSigningKey
            ? '登录服务尚未完成安全配置，请联系管理员配置 AUTH_SIGNING_KEY。'
            : '登录服务暂时异常，请稍后重试。'
        }), {
          status: missingSigningKey ? 503 : 500,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        }), request);
      }
    }

    // 3. 业务 API 路由（全部要求本人受信设备登录会话，唯独 calendar.ics 走独立 HMAC 签名校验）
    if (path.startsWith('/api/')) {
      if (path === '/api/health/calendar.ics' && request.method === 'GET') {
        const calRes = await handleHealthRoutes(request, reqEnv, url, null);
        if (calRes) return addSecurityHeaders(calRes, request);
      }

      let session = null;
      try {
        session = await getAuthSession(request, reqEnv);
      } catch (error) {
        const missingSigningKey = String(error?.message || '').includes('AUTH_SIGNING_KEY_NOT_CONFIGURED');
        return addSecurityHeaders(new Response(JSON.stringify({
          error: missingSigningKey ? 'AUTH_NOT_CONFIGURED' : 'AUTH_SERVICE_ERROR',
          message: missingSigningKey
            ? '服务尚未配置 AUTH_SIGNING_KEY 安全密钥'
            : '身份校验异常，请稍后重试'
        }), {
          status: missingSigningKey ? 503 : 500,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        }), request);
      }

      if (!session) {
        return addSecurityHeaders(new Response(JSON.stringify({
          error: 'AUTH_REQUIRED',
          message: '需要受信任设备登录认证后方可访问私有数据或识别服务'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        }), request);
      }

      if (path.startsWith('/api/ai/')) {
        const aiRes = await handleAIRoutes(request, reqEnv, url, session);
        if (aiRes) return addSecurityHeaders(aiRes, request);
      }

      if (path === '/api/health' || path.startsWith('/api/health/')) {
        const healthRes = await handleHealthRoutes(request, reqEnv, url, session, ctx);
        if (healthRes) return addSecurityHeaders(healthRes, request);
      }

      if (path.startsWith('/api/records')) {
        const recordRes = await handleRecordRoutes(request, reqEnv, url, session, ctx);
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
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      }), request);
    }

    // 4. 特殊别名：/setup 以初始化模式打开应用
    if (path === '/setup') {
      let session = null;
      let device = null;
      try {
        session = await getAuthSession(request, reqEnv);
        device = await getTrustedDevice(request, reqEnv);
      } catch {}
      if (session || device) {
        return Response.redirect(`${url.origin}/`, 302);
      }

      if (env.ASSETS) {
        try {
          const assetUrl = new URL('/index.html', request.url);
          assetUrl.searchParams.set('mode', 'setup');
          const res = await env.ASSETS.fetch(new Request(assetUrl, request));
          if (res.status === 200) return addSecurityHeaders(res, request);
        } catch {}
      }
      return Response.redirect(`${url.origin}/?mode=setup`, 302);
    }

    // 5. 根路径与静态资源兜底
    if (path === '/' || path === '/index.html') {
      if (url.searchParams.get('mode') === 'setup') {
        try {
          const session = await getAuthSession(request, reqEnv);
          const device = await getTrustedDevice(request, reqEnv);
          if (session || device) {
            return Response.redirect(`${url.origin}/`, 302);
          }
        } catch {}
      }

      if (env.ASSETS) {
        try {
          const res = await env.ASSETS.fetch(request);
          if (res.status === 200) return addSecurityHeaders(res, request);
        } catch {}
      }
      return addSecurityHeaders(new Response(getFallbackHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      }), request);
    }

    if (env.ASSETS) {
      try {
        const assetRes = await env.ASSETS.fetch(request);
        if (assetRes.status !== 404) return addSecurityHeaders(assetRes, request);
      } catch {}
    }

    // 其余 HTML 页面导航请求统一返回 SPA 兜底页
    const accept = request.headers.get('Accept') || '';
    if (accept.includes('text/html')) {
      return addSecurityHeaders(new Response(getFallbackHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      }), request);
    }

    return addSecurityHeaders(new Response('Not Found', { status: 404 }), request);
  }
};
