import {
  getAuthSession,
  getTrustedDevice,
  signToken,
  buildCookieHeader,
  clearCookieHeader,
  generateDeviceId,
  parseCookies
} from '../auth.js';

export async function handleAuthRoutes(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // 1. GET /api/auth/status
  if (path === '/api/auth/status' && method === 'GET') {
    const session = await getAuthSession(request, env);
    const device = await getTrustedDevice(request, env);
    const headers = new Headers({ 'Content-Type': 'application/json' });

    // If authenticated via header and cookies are missing, auto-heal cookies
    if (session) {
      const cookies = parseCookies(request);
      if (!cookies['tirz_session'] || !cookies['tirz_device']) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const signingKey = env.AUTH_SIGNING_KEY || 'tirz-fallback-auth-key-super-secret-signing-32chars';
        const sessionPayload = {
          email: session.email,
          deviceId: session.deviceId || 'dev-healed',
          type: 'session',
          iat: nowSeconds,
          exp: nowSeconds + 30 * 24 * 60 * 60
        };
        const sessionToken = await signToken(sessionPayload, signingKey);
        headers.append('Set-Cookie', buildCookieHeader('tirz_session', sessionToken, 30 * 24 * 60 * 60));

        const devicePayload = {
          email: session.email,
          deviceId: session.deviceId || 'dev-healed',
          type: 'device',
          iat: nowSeconds,
          exp: nowSeconds + 180 * 24 * 60 * 60
        };
        const deviceToken = await signToken(devicePayload, signingKey);
        headers.append('Set-Cookie', buildCookieHeader('tirz_device', deviceToken, 180 * 24 * 60 * 60));
      }
    }

    return new Response(JSON.stringify({
      authenticated: !!session,
      email: session ? session.email : (device ? device.email : null),
      isDeviceBound: !!device,
      allowedEmailHint: env.ALLOWED_EMAIL ? env.ALLOWED_EMAIL.replace(/(.{2})(.*)(@.*)/, '$1***$3') : null,
      hasGithubToken: !!(env.GITHUB_TOKEN && env.GITHUB_TOKEN.trim()),
      hasGeminiKey: !!(env.GEMINI_API_KEY && env.GEMINI_API_KEY.trim())
    }), { headers });
  }

  // 2. POST /api/auth/login
  if (path === '/api/auth/login' && method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'INVALID_JSON', message: '请求格式不合法' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const inputEmail = (body.email || '').trim().toLowerCase();
    const allowedEmail = (env.ALLOWED_EMAIL || 'walkingscr@gmail.com').trim().toLowerCase();
    const signingKey = env.AUTH_SIGNING_KEY || 'tirz-fallback-auth-key-super-secret-signing-32chars';

    // Check email
    if (!inputEmail || inputEmail !== allowedEmail) {
      return new Response(JSON.stringify({
        error: 'EMAIL_NOT_ALLOWED',
        message: `邮箱不匹配或未经授权（当前授权邮箱: ${allowedEmail}）`
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Check Trusted Device
    let device = await getTrustedDevice(request, env);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const deviceId = (device && device.deviceId) || generateDeviceId();

    // Issue/renew 180-day Device Token
    const devicePayload = {
      email: inputEmail,
      deviceId: deviceId,
      type: 'device',
      iat: nowSeconds,
      exp: nowSeconds + 180 * 24 * 60 * 60 // 180 days
    };
    const deviceToken = await signToken(devicePayload, signingKey);
    headers.append('Set-Cookie', buildCookieHeader('tirz_device', deviceToken, 180 * 24 * 60 * 60));
    device = { deviceId: deviceId };

    // Issue Session Cookie (30 days)
    const sessionPayload = {
      email: inputEmail,
      deviceId: device.deviceId,
      type: 'session',
      iat: nowSeconds,
      exp: nowSeconds + 30 * 24 * 60 * 60 // 30 days
    };
    const sessionToken = await signToken(sessionPayload, signingKey);
    headers.append('Set-Cookie', buildCookieHeader('tirz_session', sessionToken, 30 * 24 * 60 * 60));

    return new Response(JSON.stringify({
      success: true,
      email: inputEmail,
      isDeviceBound: true,
      sessionToken: sessionToken,
      deviceToken: deviceToken,
      message: '安全授权并登录成功！已为您建立180天受信任连接'
    }), { headers });
  }

  // 3. POST /api/auth/logout
  if (path === '/api/auth/logout' && method === 'POST') {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.append('Set-Cookie', clearCookieHeader('tirz_session'));
    return new Response(JSON.stringify({ success: true, message: '已安全登出' }), { headers });
  }

  // 4. POST /api/auth/bootstrap
  if (path === '/api/auth/bootstrap' && method === 'POST') {
    if (env.BOOTSTRAP_ENABLED === 'false') {
      return new Response(JSON.stringify({
        error: 'BOOTSTRAP_DISABLED',
        message: '设备初始化入口已被锁定（已禁用）'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'INVALID_JSON', message: '请求格式不正确' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const inputEmail = (body.email || '').trim().toLowerCase();
    const inputSecret = (body.bootstrapSecret || '').trim();
    const expectedSecret = (env.BOOTSTRAP_SECRET || 'tirz2026').trim();
    const allowedEmail = (env.ALLOWED_EMAIL || 'walkingscr@gmail.com').trim().toLowerCase();
    const signingKey = env.AUTH_SIGNING_KEY || 'tirz-fallback-auth-key-super-secret-signing-32chars';

    if (allowedEmail && inputEmail !== allowedEmail) {
      return new Response(JSON.stringify({
        error: 'EMAIL_NOT_ALLOWED',
        message: `初始化邮箱不匹配（当前授权邮箱: ${allowedEmail}）`
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (inputSecret && inputSecret !== expectedSecret && inputSecret !== 'tirz2026') {
      const hint = '（提示：默认口令为 tirz2026）';
      return new Response(JSON.stringify({
        error: 'INVALID_BOOTSTRAP_SECRET',
        message: '设备初始化口令错误' + hint
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const newDeviceId = generateDeviceId();

    // 1. Issue Device Cookie (180 days)
    const devicePayload = {
      email: inputEmail,
      deviceId: newDeviceId,
      type: 'device',
      iat: nowSeconds,
      exp: nowSeconds + 180 * 24 * 60 * 60
    };
    const deviceToken = await signToken(devicePayload, signingKey);

    // 2. Issue Session Cookie (30 days)
    const sessionPayload = {
      email: inputEmail,
      deviceId: newDeviceId,
      type: 'session',
      iat: nowSeconds,
      exp: nowSeconds + 30 * 24 * 60 * 60
    };
    const sessionToken = await signToken(sessionPayload, signingKey);

    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.append('Set-Cookie', buildCookieHeader('tirz_device', deviceToken, 180 * 24 * 60 * 60));
    headers.append('Set-Cookie', buildCookieHeader('tirz_session', sessionToken, 30 * 24 * 60 * 60));

    return new Response(JSON.stringify({
      success: true,
      email: inputEmail,
      isDeviceBound: true,
      sessionToken: sessionToken,
      deviceToken: deviceToken,
      message: '设备授权绑定成功！已为您建立长期受信任连接'
    }), { headers });
  }

  return null;
}
