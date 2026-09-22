// 身份认证与受信设备绑定模块，基于 Web Crypto API（HMAC-SHA256）实现

// 将字符串转换为 Uint8Array
function textToBuffer(str) {
  return new TextEncoder().encode(str);
}

// 将 ArrayBuffer 转换为十六进制字符串
function bufferToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Base64URL 编码/解码
function base64UrlEncode(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return decodeURIComponent(escape(atob(base64)));
}

// 获取用于 HMAC-SHA256 签名的加密密钥
async function getCryptoKey(secret) {
  return await crypto.subtle.importKey(
    'raw',
    textToBuffer(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

// 将载荷对象签名为令牌，格式为 payloadBase64.signatureHex
export async function signToken(payload, secret) {
  const jsonStr = JSON.stringify(payload);
  const payloadB64 = base64UrlEncode(jsonStr);
  const key = await getCryptoKey(secret);
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, textToBuffer(payloadB64));
  const signatureHex = bufferToHex(signatureBuffer);
  return `${payloadB64}.${signatureHex}`;
}

// 校验签名令牌，有效则返回载荷对象；无效或已过期返回 null
export async function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadB64, signatureHex] = parts;
  try {
    const key = await getCryptoKey(secret);
    // 将十六进制字符串还原为 Uint8Array
    const sigBytes = new Uint8Array(signatureHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    const isValid = await crypto.subtle.verify('HMAC', key, sigBytes, textToBuffer(payloadB64));
    if (!isValid) return null;

    const payload = JSON.parse(base64UrlDecode(payloadB64));
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < nowSeconds) {
      return null; // 已过期
    }
    return payload;
  } catch (err) {
    return null;
  }
}

// 解析 Request 中的 Cookie 请求头
export function parseCookies(request) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    if (parts.length >= 2) {
      const name = parts[0].trim();
      const val = parts.slice(1).join('=').trim();
      cookies[name] = decodeURIComponent(val);
    }
  });
  return cookies;
}

// 构建 Set-Cookie 响应头字符串
export function buildCookieHeader(name, value, maxAgeSeconds, isHttpOnly = true) {
  let header = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax; Secure`;
  if (isHttpOnly) {
    header += '; HttpOnly';
  }
  return header;
}

// 构建已过期 Cookie 响应头，用于清除 Cookie
export function clearCookieHeader(name) {
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly`;
}

// 生成随机设备 ID
export function generateDeviceId() {
  return crypto.randomUUID ? crypto.randomUUID() : 'dev-' + Math.random().toString(36).substring(2, 15);
}

function getSigningKey(env) {
  return env.AUTH_SIGNING_KEY || 'tirz-fallback-auth-key-super-secret-signing-32chars';
}

// 从请求中校验用户会话：依次尝试 Authorization 请求头、X-Device-Token 请求头、会话 Cookie，最后回退到 180 天受信设备 Cookie
export async function getAuthSession(request, env) {
  const signingKey = getSigningKey(env);
  const allowed = (env.ALLOWED_EMAIL || 'walkingscr@gmail.com').trim().toLowerCase();

  // 1. 检查 Authorization 请求头（Bearer <token>）
  const authHeader = request.headers.get('Authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.substring(7).trim();
    if (bearerToken) {
      const payload = await verifyToken(bearerToken, signingKey);
      if (payload && (payload.type === 'session' || payload.type === 'device')) {
        if (!allowed || payload.email.toLowerCase() === allowed) {
          return {
            email: payload.email,
            deviceId: payload.deviceId,
            type: 'session',
            isFromHeader: true
          };
        }
      }
    }
  }

  // 2. 检查 X-Device-Token 请求头
  const devHeader = request.headers.get('X-Device-Token');
  if (devHeader) {
    const devPayload = await verifyToken(devHeader.trim(), signingKey);
    if (devPayload && devPayload.type === 'device') {
      if (!allowed || devPayload.email.toLowerCase() === allowed) {
        return {
          email: devPayload.email,
          deviceId: devPayload.deviceId,
          type: 'session',
          isFromDeviceHeader: true
        };
      }
    }
  }

  const cookies = parseCookies(request);

  // 3. 检查直接的会话 Cookie
  const sessionToken = cookies['tirz_session'];
  if (sessionToken) {
    const payload = await verifyToken(sessionToken, signingKey);
    if (payload && payload.type === 'session') {
      if (!allowed || payload.email.toLowerCase() === allowed) {
        return payload;
      }
    }
  }

  // 4. 回退到 180 天受信设备 Cookie，确保刷新页面不会强制重新登录
  const deviceToken = cookies['tirz_device'];
  if (deviceToken) {
    const devPayload = await verifyToken(deviceToken, signingKey);
    if (devPayload && devPayload.type === 'device') {
      if (!allowed || devPayload.email.toLowerCase() === allowed) {
        return {
          email: devPayload.email,
          deviceId: devPayload.deviceId,
          type: 'session',
          isFromDevice: true
        };
      }
    }
  }

  return null;
}

// 从请求中校验受信设备：依次尝试 X-Device-Token 请求头、Authorization 请求头、tirz_device Cookie
export async function getTrustedDevice(request, env) {
  const signingKey = getSigningKey(env);
  const allowed = (env.ALLOWED_EMAIL || 'walkingscr@gmail.com').trim().toLowerCase();

  // 1. 检查 X-Device-Token 请求头
  const devHeader = request.headers.get('X-Device-Token');
  if (devHeader) {
    const payload = await verifyToken(devHeader.trim(), signingKey);
    if (payload && payload.type === 'device') {
      if (!allowed || payload.email.toLowerCase() === allowed) {
        return payload;
      }
    }
  }

  // 2. 检查 Authorization 请求头
  const authHeader = request.headers.get('Authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    if (token) {
      const payload = await verifyToken(token, signingKey);
      if (payload && payload.type === 'device') {
        if (!allowed || payload.email.toLowerCase() === allowed) {
          return payload;
        }
      }
    }
  }

  // 3. 检查 Cookie
  const cookies = parseCookies(request);
  const deviceToken = cookies['tirz_device'];
  if (!deviceToken) return null;

  const payload = await verifyToken(deviceToken, signingKey);
  if (!payload || payload.type !== 'device') return null;

  // 校验邮箱是否与允许的邮箱一致
  if (allowed && payload.email.toLowerCase() !== allowed) {
    return null;
  }
  return payload;
}