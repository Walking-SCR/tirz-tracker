// Authentication and Trusted Device Binding module using Web Crypto API (HMAC-SHA256)

// Convert string to Uint8Array
function textToBuffer(str) {
  return new TextEncoder().encode(str);
}

// Convert ArrayBuffer to Hex String
function bufferToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Base64URL encode/decode
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

// Get crypto key for HMAC-SHA256
async function getCryptoKey(secret) {
  return await crypto.subtle.importKey(
    'raw',
    textToBuffer(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

// Sign payload object into a signed token: payloadBase64.signatureHex
export async function signToken(payload, secret) {
  const jsonStr = JSON.stringify(payload);
  const payloadB64 = base64UrlEncode(jsonStr);
  const key = await getCryptoKey(secret);
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, textToBuffer(payloadB64));
  const signatureHex = bufferToHex(signatureBuffer);
  return `${payloadB64}.${signatureHex}`;
}

// Verify signed token, returns payload object or null if invalid or expired
export async function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadB64, signatureHex] = parts;
  try {
    const key = await getCryptoKey(secret);
    // Convert hex back to Uint8Array
    const sigBytes = new Uint8Array(signatureHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    const isValid = await crypto.subtle.verify('HMAC', key, sigBytes, textToBuffer(payloadB64));
    if (!isValid) return null;

    const payload = JSON.parse(base64UrlDecode(payloadB64));
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < nowSeconds) {
      return null; // Expired
    }
    return payload;
  } catch (err) {
    return null;
  }
}

// Parse Cookie header from Request
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

// Build Set-Cookie header string
export function buildCookieHeader(name, value, maxAgeSeconds, isHttpOnly = true) {
  let header = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax; Secure`;
  if (isHttpOnly) {
    header += '; HttpOnly';
  }
  return header;
}

// Build expired cookie header to clear cookie
export function clearCookieHeader(name) {
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly`;
}

// Generate random UUID
export function generateDeviceId() {
  return crypto.randomUUID ? crypto.randomUUID() : 'dev-' + Math.random().toString(36).substring(2, 15);
}

function getSigningKey(env) {
  return env.AUTH_SIGNING_KEY || 'tirz-fallback-auth-key-super-secret-signing-32chars';
}

// Verify user session from request (supports Authorization header, X-Device-Token header, session cookie OR 180-day trusted device cookie)
export async function getAuthSession(request, env) {
  const signingKey = getSigningKey(env);
  const allowed = (env.ALLOWED_EMAIL || 'walkingscr@gmail.com').trim().toLowerCase();

  // 1. Check Authorization header (Bearer <token>)
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

  // 2. Check X-Device-Token header
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

  // 3. Check direct session cookie
  const sessionToken = cookies['tirz_session'];
  if (sessionToken) {
    const payload = await verifyToken(sessionToken, signingKey);
    if (payload && payload.type === 'session') {
      if (!allowed || payload.email.toLowerCase() === allowed) {
        return payload;
      }
    }
  }

  // 4. Fallback to 180-day trusted device cookie so refresh never forces re-login
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

// Verify trusted device from request (supports X-Device-Token, Authorization header, or tirz_device cookie)
export async function getTrustedDevice(request, env) {
  const signingKey = getSigningKey(env);
  const allowed = (env.ALLOWED_EMAIL || 'walkingscr@gmail.com').trim().toLowerCase();

  // 1. Check X-Device-Token header
  const devHeader = request.headers.get('X-Device-Token');
  if (devHeader) {
    const payload = await verifyToken(devHeader.trim(), signingKey);
    if (payload && payload.type === 'device') {
      if (!allowed || payload.email.toLowerCase() === allowed) {
        return payload;
      }
    }
  }

  // 2. Check Authorization header
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

  // 3. Check Cookie
  const cookies = parseCookies(request);
  const deviceToken = cookies['tirz_device'];
  if (!deviceToken) return null;

  const payload = await verifyToken(deviceToken, signingKey);
  if (!payload || payload.type !== 'device') return null;

  // Verify email matches allowed email
  if (allowed && payload.email.toLowerCase() !== allowed) {
    return null;
  }
  return payload;
}
