// AI Scale Vision Analysis Route.
// Primary: MiniMax-M3 (OpenAI-compatible multimodal, no regional blocking).
// Fallback: Gemini via Vertex AI then the public Gemini endpoint (HEIC
// passthrough and MiniMax outage coverage).
// The browser never supplies an API key: secrets live in Worker Secrets.

const MAX_IMAGE_BASE64_LENGTH = 4_000_000;
const UPSTREAM_TIMEOUT_MS = 8_000;
// Hard ceiling for the whole upstream retry chain so the Worker always
// answers before the frontend's 20s abort.
const TOTAL_UPSTREAM_BUDGET_MS = 12_000;
// MiniMax China platform (OpenAI-compatible Chat Completions).
const MINIMAX_API_URL = 'https://api.minimaxi.com/v1/chat/completions';
const MINIMAX_MODEL = 'MiniMax-M3';
// MiniMax vision only accepts JPEG/PNG/GIF/WEBP; HEIC/HEIF passthrough goes
// straight to the Gemini fallback chain.
const MINIMAX_SUPPORTED_MIME = /^image\/(?:jpeg|png|gif|webp)$/;
const GEMINI_ENDPOINTS = [
  { name: 'vertex', baseUrl: 'https://aiplatform.googleapis.com/v1/publishers/google/models' },
  { name: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models' }
];

function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text.trim()); } catch {}
  const codeFenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeFenceMatch) {
    try { return JSON.parse(codeFenceMatch[1].trim()); } catch {}
  }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(text.substring(firstBrace, lastBrace + 1)); } catch {}
  }
  const numMatch = text.match(/(\d{2,3}(?:\.\d{1,2})?)/);
  return numMatch ? { weight: parseFloat(numMatch[1]), unit: '斤' } : null;
}

function parseWeight(parsed) {
  let weight = parsed?.weight;
  weight = typeof weight === 'string' ? parseFloat(weight.replace(/[^0-9.]/g, '')) : Number(weight);
  return Number.isFinite(weight) && weight > 0 ? weight : null;
}

function jsonResponse(payload, status, requestId) {
  return new Response(JSON.stringify({ ...payload, requestId }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Request-ID': requestId }
  });
}

function logEvent(level, event, fields) {
  const line = JSON.stringify({ event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function readUpstreamReason(upstreamText) {
  let reason = upstreamText.slice(0, 240);
  try {
    const parsedError = JSON.parse(upstreamText);
    reason = parsedError.error?.message || parsedError.message || reason;
  } catch {}
  return reason;
}

export async function handleAIRoutes(request, env, url, session) {
  if (url.pathname !== '/api/ai/analyze-scale' || request.method !== 'POST') return null;

  const requestId = request.headers.get('X-Request-ID') || crypto.randomUUID();
  const startedAt = Date.now();
  let body;
  try {
    body = await request.json();
  } catch {
    logEvent('warn', 'ai_request_rejected', { requestId, reason: 'invalid_json' });
    return jsonResponse({ error: 'INVALID_JSON', message: '请求格式不合法' }, 400, requestId);
  }

  const { imageBase64 } = body || {};
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    logEvent('warn', 'ai_request_rejected', { requestId, reason: 'missing_image' });
    return jsonResponse({ error: 'MISSING_IMAGE', message: '缺少图片数据' }, 400, requestId);
  }

  const mimeMatch = imageBase64.match(/^data:([^;]+);base64,/i);
  const rawMimeType = (mimeMatch ? mimeMatch[1] : 'image/jpeg').toLowerCase();
  const mimeType = rawMimeType === 'image/jpg' ? 'image/jpeg' : rawMimeType;
  const pureBase64 = imageBase64.replace(/^data:[^;]+;base64,/i, '').replace(/\s/g, '');
  if (!/^image\/(?:jpeg|png|webp|heic|heif)$/.test(mimeType)) {
    logEvent('warn', 'ai_request_rejected', { requestId, reason: 'unsupported_mime', mimeType });
    return jsonResponse({ error: 'UNSUPPORTED_IMAGE_TYPE', message: '暂不支持此图片格式，请重试' }, 415, requestId);
  }
  if (!pureBase64 || pureBase64.length < 100) {
    logEvent('warn', 'ai_request_rejected', { requestId, reason: 'invalid_image', mimeType });
    return jsonResponse({ error: 'INVALID_IMAGE', message: '未获取到有效的秤面照片数据' }, 400, requestId);
  }
  if (pureBase64.length > MAX_IMAGE_BASE64_LENGTH) {
    logEvent('warn', 'ai_request_rejected', { requestId, reason: 'image_too_large', mimeType, base64Length: pureBase64.length });
    return jsonResponse({ error: 'IMAGE_TOO_LARGE', message: '图片过大，请重新拍摄或压缩后上传' }, 413, requestId);
  }

  const minimaxKey = typeof env.MINIMAX_API_KEY === 'string' ? env.MINIMAX_API_KEY.trim() : '';
  const geminiKey = typeof env.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY.trim() : '';
  if (!minimaxKey && !geminiKey) {
    logEvent('error', 'ai_request_rejected', { requestId, reason: 'missing_worker_secret' });
    return jsonResponse({ error: 'AI_NOT_CONFIGURED', message: '服务器尚未配置 AI 识别服务' }, 503, requestId);
  }

  logEvent('info', 'ai_request_started', { requestId, mimeType, imageBase64Length: pureBase64.length, primary: minimaxKey ? 'minimax' : 'gemini' });
  const prompt = `Extract the weight number from this digital bathroom scale photo (white/colored LED digits under glass or LCD 7-segment display). Return ONLY valid JSON: {"weight": number, "unit": "斤"}. Example: {"weight": 168.5, "unit": "斤"}`;
  let lastError = null;
  let lastStatus = 502;
  const upstreamStatuses = [];
  const upstreamReasons = [];
  let lastUpstreamReason = '';
  let timeoutCount = 0;
  let attemptCount = 0;

  // --- Primary: MiniMax-M3 (skip for HEIC/HEIF which it cannot decode) ---
  if (minimaxKey && MINIMAX_SUPPORTED_MIME.test(mimeType)) {
    attemptCount += 1;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    const attemptStartedAt = Date.now();
    try {
      const res = await fetch(MINIMAX_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${minimaxKey}` },
        signal: controller.signal,
        body: JSON.stringify({
          model: MINIMAX_MODEL,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${pureBase64}` } }
            ]
          }],
          max_completion_tokens: 64,
          temperature: 0,
          thinking: { type: 'disabled' }
        })
      });

      lastStatus = res.status;
      if (!res.ok) {
        upstreamStatuses.push(res.status);
        const upstreamText = await res.text().catch(() => '');
        lastUpstreamReason = readUpstreamReason(upstreamText);
        upstreamReasons.push(lastUpstreamReason);
        lastError = new Error(`MiniMax HTTP ${res.status}`);
        logEvent('warn', 'ai_upstream_error', {
          requestId, endpoint: 'minimax', model: MINIMAX_MODEL, status: res.status,
          reason: String(lastUpstreamReason).replace(/[\r\n]+/g, ' ').slice(0, 240),
          durationMs: Date.now() - attemptStartedAt
        });
      } else {
        const data = await res.json();
        const parsed = extractJson(data.choices?.[0]?.message?.content);
        const weight = parseWeight(parsed);
        if (weight === null) {
          lastError = new Error('MiniMax response did not contain a valid weight');
          logEvent('warn', 'ai_upstream_error', { requestId, endpoint: 'minimax', model: MINIMAX_MODEL, status: 200, reason: 'invalid_model_payload', durationMs: Date.now() - attemptStartedAt });
        } else {
          logEvent('info', 'ai_request_completed', { requestId, endpoint: 'minimax', model: MINIMAX_MODEL, durationMs: Date.now() - startedAt, hasWeight: true });
          return jsonResponse({ success: true, weight, unit: parsed.unit || '斤', confidence: parsed.confidence || 'high', model: MINIMAX_MODEL }, 200, requestId);
        }
      }
    } catch (err) {
      lastError = err;
      const timedOut = err?.name === 'AbortError';
      if (timedOut) timeoutCount += 1;
      logEvent('warn', 'ai_upstream_error', { requestId, endpoint: 'minimax', model: MINIMAX_MODEL, reason: timedOut ? 'timeout' : 'network_error', durationMs: Date.now() - attemptStartedAt });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // --- Fallback chain: Gemini via Vertex AI, then the public endpoint ---
  const modelsToTry = ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite'];

  attemptLoop:
  for (const endpoint of GEMINI_ENDPOINTS) {
    for (const model of modelsToTry) {
      if (!geminiKey) break attemptLoop;
      if (attemptCount > 0 && Date.now() - startedAt > TOTAL_UPSTREAM_BUDGET_MS) break attemptLoop;
      attemptCount += 1;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
      const modelStartedAt = Date.now();
      try {
        const apiUrl = `${endpoint.baseUrl}/${model}:generateContent`;
        const payload = {
          contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType, data: pureBase64 } }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0,
            maxOutputTokens: 32
          }
        };

        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
          signal: controller.signal,
          body: JSON.stringify(payload)
        });

        lastStatus = res.status;
        if (!res.ok) {
          upstreamStatuses.push(res.status);
          const upstreamText = await res.text().catch(() => '');
          lastUpstreamReason = readUpstreamReason(upstreamText);
          upstreamReasons.push(lastUpstreamReason);
          lastError = new Error(`Upstream HTTP ${res.status} (${endpoint.name})`);
          logEvent('warn', 'ai_upstream_error', {
            requestId, endpoint: endpoint.name, model, status: res.status,
            reason: String(lastUpstreamReason).replace(/[\r\n]+/g, ' ').slice(0, 240),
            durationMs: Date.now() - modelStartedAt
          });
          continue;
        }
        const data = await res.json();
        const parsed = extractJson(data.candidates?.[0]?.content?.parts?.[0]?.text);
        const weight = parseWeight(parsed);
        if (weight === null) {
          lastError = new Error('Upstream response did not contain a valid weight');
          logEvent('warn', 'ai_upstream_error', { requestId, endpoint: endpoint.name, model, status: 200, reason: 'invalid_model_payload', durationMs: Date.now() - modelStartedAt });
          continue;
        }
        logEvent('info', 'ai_request_completed', { requestId, endpoint: endpoint.name, model, durationMs: Date.now() - startedAt, hasWeight: true });
        return jsonResponse({ success: true, weight, unit: parsed.unit || '斤', confidence: parsed.confidence || 'high', model }, 200, requestId);
      } catch (err) {
        lastError = err;
        const timedOut = err?.name === 'AbortError';
        if (timedOut) timeoutCount += 1;
        logEvent('warn', 'ai_upstream_error', { requestId, endpoint: endpoint.name, model, reason: timedOut ? 'timeout' : 'network_error', durationMs: Date.now() - modelStartedAt });
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  const timedOut = attemptCount > 0 && timeoutCount === attemptCount;
  // "User location is not supported for the API use." — the upstream rejects
  // the Worker's egress region, not the image. Report it honestly instead of
  // mislabeling it as an image-format problem.
  const geoBlocked = upstreamReasons.some((reason) => /location is not supported/i.test(reason));
  const authFailed = upstreamStatuses.some(status => status === 401 || status === 403);
  const rateLimited = upstreamStatuses.includes(429);
  // A single 400 alongside a timeout/network error is not enough evidence that
  // the image is invalid; otherwise a transient fallback failure is misreported
  // to the user as an image-format problem.
  const badRequest = upstreamStatuses.length > 0 && upstreamStatuses.every(status => status === 400) && timeoutCount === 0 && !geoBlocked;
  const error = geoBlocked
    ? 'AI_REGION_BLOCKED'
    : timedOut
      ? 'AI_UPSTREAM_TIMEOUT'
      : authFailed
        ? 'AI_AUTH_FAILED'
        : rateLimited
          ? 'AI_RATE_LIMITED'
          : badRequest
            ? 'AI_BAD_REQUEST'
            : 'AI_RECOGNITION_FAILED';
  const message = geoBlocked
    ? '识别服务在当前网络出口区域不可用，请更换网络（如切换 Wi-Fi/蜂窝数据）后重试'
    : timedOut
      ? '识别服务响应超时，请稍后重试'
      : authFailed
        ? (lastUpstreamReason || 'AI 服务认证失败或额度不可用，请联系管理员')
        : rateLimited
          ? 'AI 服务请求频繁或额度已用尽，请稍后重试'
          : badRequest
            ? (lastUpstreamReason ? `图片解析失败: ${lastUpstreamReason}` : '图片格式或内容无法处理，请重新拍摄')
            : (lastUpstreamReason || '识别服务暂时不可用，请稍后重试');
  logEvent('error', 'ai_request_failed', { requestId, error, upstreamStatus: lastStatus, durationMs: Date.now() - startedAt });
  return jsonResponse({ error, message }, timedOut ? 504 : 502, requestId);
}
