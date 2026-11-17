// 身份认证与受信设备绑定模块，基于 Web Crypto API（HMAC-SHA256）实现

// 将字符串转换为 Uint8Array
function textToBuffer(str) {
  return new TextEncoder().encode(str);
}

// 将 ArrayBuffer 转换为十六进制字符串
function bufferToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// Base64URL 编码/解码（使用 TextEncoder / TextDecoder，避免废弃的 escape/unescape）
function base64UrlEncode(str) {
  const bytes = textToBuffer(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
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

// 常量时间字符串比较（基于 HMAC-SHA256 摘要，消除长度与字符逐位早退时序侧信道）
export async function timingSafeEqualString(a, b, secret = 'tirz-constant-time-compare') {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const key = await getCryptoKey(secret);
  const sigA = new Uint8Array(await crypto.subtle.sign('HMAC', key, textToBuffer(a)));
  return await crypto.subtle.verify('HMAC', key, sigA, textToBuffer(b));
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
  if (!/^[0-9a-f]{64}$/i.test(signatureHex)) return null;
  try {
    const key = await getCryptoKey(secret);
    const sigBytes = Uint8Array.from(signatureHex.match(/.{2}/g), byte => parseInt(byte, 16));
    const isValid = await crypto.subtle.verify('HMAC', key, sigBytes, textToBuffer(payloadB64));
    if (!isValid) return null;

    const payload = JSON.parse(base64UrlDecode(payloadB64));
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < nowSeconds) {
      return null; // 已过期
    }
    return payload;
  } catch {
    return null;
  }
}

// 解析 Request 中的 Cookie 请求头
export function parseCookies(request) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const idx = cookie.indexOf('=');
    if (idx > 0) {
      const name = cookie.slice(0, idx).trim();
      const val = cookie.slice(idx + 1).trim();
      try {
        cookies[name] = decodeURIComponent(val);
      } catch {
        cookies[name] = val;
      }
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

// 生成随机设备 ID（仅使用密码学安全的 Web Crypto PRNG）
export function generateDeviceId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return 'dev-' + bufferToHex(bytes);
}

// 获取 HMAC 签名密钥。未配置时直接抛错，绝不退化为公开的默认值：
// 默认值一旦生效，攻击者即可用已知常量伪造会话 Cookie 绕过认证。
export function getSigningKey(env) {
  const key = (env && env.AUTH_SIGNING_KEY) ? env.AUTH_SIGNING_KEY.trim() : '';
  if (!key) {
    throw new Error('AUTH_SIGNING_KEY_NOT_CONFIGURED: 必须在 Worker Secrets 中配置 AUTH_SIGNING_KEY');
  }
  return key;
}

export function maskEmail(email) {
  const clean = String(email || '').trim();
  const atIndex = clean.indexOf('@');
  if (atIndex <= 0) return null;
  const local = clean.slice(0, atIndex);
  const domain = clean.slice(atIndex);
  const prefix = local.slice(0, Math.min(2, local.length));
  return `${prefix}***${domain}`;
}

// 从请求中校验用户会话：依次尝试 Authorization 请求头、X-Device-Token 请求头、会话 Cookie，最后回退到 180 天受信设备 Cookie
export async function getAuthSession(request, env) {
  const signingKey = getSigningKey(env);
  const allowed = (env.ALLOWED_EMAIL || '').trim().toLowerCase();

  const cookies = parseCookies(request);
  // 若用户已显式退出当前会话（tirz_logged_out=1），禁止由设备凭证自动无感恢复会话，直到再次执行 login
  const loggedOutFlag = cookies['tirz_logged_out'] === '1';

  // 1. 检查 Authorization 请求头（Bearer <token>）
  const authHeader = request.headers.get('Authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.substring(7).trim();
    if (bearerToken) {
      const payload = await verifyToken(bearerToken, signingKey);
      if (payload && (payload.type === 'session' || (payload.type === 'device' && !loggedOutFlag))) {
        if (!allowed || String(payload.email || '').toLowerCase() === allowed) {
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

  // 2. 检查直接的会话 Cookie
  const sessionToken = cookies['tirz_session'];
  if (sessionToken) {
    const payload = await verifyToken(sessionToken, signingKey);
    if (payload && payload.type === 'session') {
      if (!allowed || String(payload.email || '').toLowerCase() === allowed) {
        return payload;
      }
    }
  }

  if (loggedOutFlag) return null;

  // 3. 检查 X-Device-Token 请求头
  const devHeader = request.headers.get('X-Device-Token');
  if (devHeader) {
    const devPayload = await verifyToken(devHeader.trim(), signingKey);
    if (devPayload && devPayload.type === 'device') {
      if (!allowed || String(devPayload.email || '').toLowerCase() === allowed) {
        return {
          email: devPayload.email,
          deviceId: devPayload.deviceId,
          type: 'session',
          isFromDeviceHeader: true
        };
      }
    }
  }

  // 4. 回退到 180 天受信设备 Cookie，确保刷新页面不会强制重新登录
  const deviceToken = cookies['tirz_device'];
  if (deviceToken) {
    const devPayload = await verifyToken(deviceToken, signingKey);
    if (devPayload && devPayload.type === 'device') {
      if (!allowed || String(devPayload.email || '').toLowerCase() === allowed) {
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
  const allowed = (env.ALLOWED_EMAIL || '').trim().toLowerCase();

  // 1. 检查 X-Device-Token 请求头
  const devHeader = request.headers.get('X-Device-Token');
  if (devHeader) {
    const payload = await verifyToken(devHeader.trim(), signingKey);
    if (payload && payload.type === 'device') {
      if (!allowed || String(payload.email || '').toLowerCase() === allowed) {
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
        if (!allowed || String(payload.email || '').toLowerCase() === allowed) {
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

  if (allowed && String(payload.email || '').toLowerCase() !== allowed) {
    return null;
  }
  return payload;
}
