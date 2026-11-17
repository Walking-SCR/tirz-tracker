import {
  getAuthSession,
  getTrustedDevice,
  getSigningKey,
  signToken,
  buildCookieHeader,
  clearCookieHeader,
  generateDeviceId,
  parseCookies,
  timingSafeEqualString,
  maskEmail
} from '../auth.js';
import { getEffectiveGithubToken } from '../github.js';

export async function handleAuthRoutes(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // 1. GET /api/auth/status：查询当前认证状态
  if (path === '/api/auth/status' && (method === 'GET' || method === 'HEAD')) {
    const session = await getAuthSession(request, env);
    const device = await getTrustedDevice(request, env);
    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });

    // 若通过请求头或受信设备认证成功但缺少会话 Cookie，则自动补齐 Cookie
    if (session) {
      const cookies = parseCookies(request);
      if (!cookies['tirz_session'] || !cookies['tirz_device']) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const signingKey = getSigningKey(env);
        const sessionPayload = {
          email: session.email,
          deviceId: session.deviceId || generateDeviceId(),
          type: 'session',
          iat: nowSeconds,
          exp: nowSeconds + 30 * 24 * 60 * 60
        };
        const sessionToken = await signToken(sessionPayload, signingKey);
        headers.append('Set-Cookie', buildCookieHeader('tirz_session', sessionToken, 30 * 24 * 60 * 60));

        if (!cookies['tirz_device']) {
          const devicePayload = {
            email: session.email,
            deviceId: sessionPayload.deviceId,
            type: 'device',
            iat: nowSeconds,
            exp: nowSeconds + 180 * 24 * 60 * 60
          };
          const deviceToken = await signToken(devicePayload, signingKey);
          headers.append('Set-Cookie', buildCookieHeader('tirz_device', deviceToken, 180 * 24 * 60 * 60));
        }
      }
    }

    return new Response(JSON.stringify({
      authenticated: !!session,
      email: session ? maskEmail(session.email) : (device ? maskEmail(device.email) : null),
      isDeviceBound: !!device,
      bootstrapEnabled: env.BOOTSTRAP_ENABLED !== 'false',
      allowedEmailHint: maskEmail(env.ALLOWED_EMAIL),
      hasGithubToken: !!getEffectiveGithubToken(env),
      hasGeminiKey: !!(env.GEMINI_API_KEY && env.GEMINI_API_KEY.trim()),
      hasMinimaxKey: !!(env.MINIMAX_API_KEY && env.MINIMAX_API_KEY.trim())
    }), { headers });
  }

  // 2. POST /api/auth/login：邮箱 + 已绑定受信设备双因子校验登录
  if (path === '/api/auth/login' && method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'INVALID_JSON', message: '请求格式不合法' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const inputEmail = (body?.email || '').trim().toLowerCase();
    const allowedEmail = (env.ALLOWED_EMAIL || '').trim().toLowerCase();
    const signingKey = getSigningKey(env);

    // 校验邮箱是否在白名单内（绝不在错误消息中回显真实授权邮箱）
    if (!inputEmail || !allowedEmail || !(await timingSafeEqualString(inputEmail, allowedEmail, signingKey))) {
      return new Response(JSON.stringify({
        error: 'EMAIL_NOT_ALLOWED',
        message: '邮箱不匹配或未经授权'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    // 严格要求当前请求已携带合法的受信设备凭证（Cookie 或 X-Device-Token）
    // 新设备必须先通过 /setup（/api/auth/bootstrap）校验 BOOTSTRAP_SECRET 完成首次绑定
    const device = await getTrustedDevice(request, env);
    if (!device || !device.deviceId) {
      return new Response(JSON.stringify({
        error: 'DEVICE_NOT_BOUND',
        message: '当前设备尚未完成首次安全绑定，请先使用初始化口令绑定设备'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });

    // 续期 180 天设备令牌并清除退出标记
    const devicePayload = {
      email: inputEmail,
      deviceId: device.deviceId,
      type: 'device',
      iat: nowSeconds,
      exp: nowSeconds + 180 * 24 * 60 * 60
    };
    const deviceToken = await signToken(devicePayload, signingKey);
    headers.append('Set-Cookie', buildCookieHeader('tirz_device', deviceToken, 180 * 24 * 60 * 60));
    headers.append('Set-Cookie', clearCookieHeader('tirz_logged_out'));

    // 签发会话 Cookie（30 天）
    const sessionPayload = {
      email: inputEmail,
      deviceId: device.deviceId,
      type: 'session',
      iat: nowSeconds,
      exp: nowSeconds + 30 * 24 * 60 * 60
    };
    const sessionToken = await signToken(sessionPayload, signingKey);
    headers.append('Set-Cookie', buildCookieHeader('tirz_session', sessionToken, 30 * 24 * 60 * 60));

    return new Response(JSON.stringify({
      success: true,
      email: maskEmail(inputEmail),
      isDeviceBound: true,
      sessionToken,
      deviceToken,
      message: '安全验证通过，已恢复 30 天登录会话'
    }), { headers });
  }

  // 3. POST /api/auth/logout：清除会话 Cookie，并标记当前已退出（保留设备绑定以便下次仅凭邮箱重登，若传 revokeDevice 则连同设备解绑）
  if (path === '/api/auth/logout' && method === 'POST') {
    let revokeDevice = false;
    try {
      const body = await request.json();
      revokeDevice = body?.revokeDevice === true;
    } catch {}

    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    headers.append('Set-Cookie', clearCookieHeader('tirz_session'));
    if (revokeDevice) {
      headers.append('Set-Cookie', clearCookieHeader('tirz_device'));
      headers.append('Set-Cookie', clearCookieHeader('tirz_logged_out'));
    } else {
      headers.append('Set-Cookie', buildCookieHeader('tirz_logged_out', '1', 30 * 24 * 60 * 60));
    }
    return new Response(JSON.stringify({ success: true, message: '已安全登出' }), { headers });
  }

  // 4. POST /api/auth/bootstrap：使用服务端 BOOTSTRAP_SECRET 完成新设备首次绑定
  if (path === '/api/auth/bootstrap' && method === 'POST') {
    if (env.BOOTSTRAP_ENABLED === 'false') {
      return new Response(JSON.stringify({
        error: 'BOOTSTRAP_DISABLED',
        message: '设备初始化入口已被锁定（已禁用）'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const expectedSecret = (env.BOOTSTRAP_SECRET || '').trim();
    if (!expectedSecret) {
      return new Response(JSON.stringify({
        error: 'BOOTSTRAP_NOT_CONFIGURED',
        message: '服务器尚未配置 BOOTSTRAP_SECRET，无法执行新设备绑定'
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'INVALID_JSON', message: '请求格式不正确' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const inputEmail = (body?.email || '').trim().toLowerCase();
    const inputSecret = (body?.bootstrapSecret || '').trim();
    const allowedEmail = (env.ALLOWED_EMAIL || '').trim().toLowerCase();
    const signingKey = getSigningKey(env);

    if (!inputEmail || (allowedEmail && !(await timingSafeEqualString(inputEmail, allowedEmail, signingKey)))) {
      return new Response(JSON.stringify({
        error: 'EMAIL_NOT_ALLOWED',
        message: '初始化邮箱不匹配或未经授权'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    if (!inputSecret || !(await timingSafeEqualString(inputSecret, expectedSecret, signingKey))) {
      return new Response(JSON.stringify({
        error: 'INVALID_BOOTSTRAP_SECRET',
        message: '设备初始化口令错误，请核对 Worker Secret 配置'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const newDeviceId = generateDeviceId();

    const devicePayload = {
      email: inputEmail,
      deviceId: newDeviceId,
      type: 'device',
      iat: nowSeconds,
      exp: nowSeconds + 180 * 24 * 60 * 60
    };
    const deviceToken = await signToken(devicePayload, signingKey);

    const sessionPayload = {
      email: inputEmail,
      deviceId: newDeviceId,
      type: 'session',
      iat: nowSeconds,
      exp: nowSeconds + 30 * 24 * 60 * 60
    };
    const sessionToken = await signToken(sessionPayload, signingKey);

    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    headers.append('Set-Cookie', buildCookieHeader('tirz_device', deviceToken, 180 * 24 * 60 * 60));
    headers.append('Set-Cookie', buildCookieHeader('tirz_session', sessionToken, 30 * 24 * 60 * 60));
    headers.append('Set-Cookie', clearCookieHeader('tirz_logged_out'));

    return new Response(JSON.stringify({
      success: true,
      email: maskEmail(inputEmail),
      isDeviceBound: true,
      sessionToken,
      deviceToken,
      message: '设备授权绑定成功！已为您建立长期受信任连接'
    }), { headers });
  }

  return null;
}
