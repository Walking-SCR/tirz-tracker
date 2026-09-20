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
  let header = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Strict; Secure`;
  if (isHttpOnly) {
    header += '; HttpOnly';
  }
  return header;
}

// Build expired cookie header to clear cookie
export function clearCookieHeader(name) {
  return `${name}=; Path=/; Max-Age=0; SameSite=Strict; Secure; HttpOnly`;
}

// Generate random UUID
export function generateDeviceId() {
  return crypto.randomUUID ? crypto.randomUUID() : 'dev-' + Math.random().toString(36).substring(2, 15);
}

// Verify user session from request
export async function getAuthSession(request, env) {
  const cookies = parseCookies(request);
  const sessionToken = cookies['tirz_session'];
  if (!sessionToken || !env.AUTH_SIGNING_KEY) return null;

  const payload = await verifyToken(sessionToken, env.AUTH_SIGNING_KEY);
  if (!payload || payload.type !== 'session') return null;

  // Verify email matches allowed email
  const allowed = (env.ALLOWED_EMAIL || '').trim().toLowerCase();
  if (allowed && payload.email.toLowerCase() !== allowed) {
    return null;
  }
  return payload;
}

// Verify trusted device cookie from request
export async function getTrustedDevice(request, env) {
  const cookies = parseCookies(request);
  const deviceToken = cookies['tirz_device'];
  if (!deviceToken || !env.AUTH_SIGNING_KEY) return null;

  const payload = await verifyToken(deviceToken, env.AUTH_SIGNING_KEY);
  if (!payload || payload.type !== 'device') return null;

  // Verify email matches allowed email
  const allowed = (env.ALLOWED_EMAIL || '').trim().toLowerCase();
  if (allowed && payload.email.toLowerCase() !== allowed) {
    return null;
  }
  return payload;
}
