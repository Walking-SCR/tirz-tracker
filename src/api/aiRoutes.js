// AI Scale Vision Analysis Route using Google Gemini Multimodal API.
// The browser never supplies an API key: GEMINI_API_KEY must be a Worker Secret.

const MAX_IMAGE_BASE64_LENGTH = 4_000_000;
const UPSTREAM_TIMEOUT_MS = 8_000;

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
  // Gemini accepts both JPEG spellings, but image/jpeg is the canonical value.
  const mimeType = rawMimeType === 'image/jpg' ? 'image/jpeg' : rawMimeType;
  const pureBase64 = imageBase64.replace(/^data:[^;]+;base64,/i, '').replace(/\s/g, '');
  if (!/^image\/(?:jpeg|png|webp|heic|heif)$/.test(mimeType)) {
    logEvent('warn', 'ai_request_rejected', { requestId, reason: 'unsupported_mime', mimeType });
    return jsonResponse({ error: 'UNSUPPORTED_IMAGE_TYPE', message: '仅支持 JPG、PNG、WebP、HEIC 或 HEIF 图片' }, 415, requestId);
  }
  if (!pureBase64 || pureBase64.length < 100) {
    logEvent('warn', 'ai_request_rejected', { requestId, reason: 'invalid_image', mimeType });
    return jsonResponse({ error: 'INVALID_IMAGE', message: '未获取到有效的秤面照片数据' }, 400, requestId);
  }
  if (pureBase64.length > MAX_IMAGE_BASE64_LENGTH) {
    logEvent('warn', 'ai_request_rejected', { requestId, reason: 'image_too_large', mimeType, base64Length: pureBase64.length });
    return jsonResponse({ error: 'IMAGE_TOO_LARGE', message: '图片过大，请重新拍摄或压缩后上传' }, 413, requestId);
  }

  const apiKey = typeof env.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY.trim() : '';
  if (!apiKey) {
    logEvent('error', 'ai_request_rejected', { requestId, reason: 'missing_worker_secret' });
    return jsonResponse({ error: 'AI_NOT_CONFIGURED', message: '服务器尚未配置 Gemini API Key' }, 503, requestId);
  }

  logEvent('info', 'ai_request_started', { requestId, mimeType, imageBase64Length: pureBase64.length });
  const prompt = `You are a high-speed digital weight scale OCR engine. Look at the bathroom scale photo (including white or colored LED glowing digits under glass, LCD displays, and 7-segment numbers). Extract the weight numeric reading. Return ONLY a valid JSON: {"weight": number, "unit": "斤" or "kg", "confidence": "high"}. Example: {"weight": 168.5, "unit": "斤", "confidence": "high"}`;
  // The numbered model is currently the more reliable first choice. Keep the
  // alias as a fallback for transient model/region failures.
  const modelsToTry = ['gemini-3.1-flash-lite', 'gemini-flash-lite-latest'];
  let lastError = null;
  let lastStatus = 502;
  const upstreamStatuses = [];
  let timeoutCount = 0;

  for (const model of modelsToTry) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    const modelStartedAt = Date.now();
    try {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType, data: pureBase64 } }] }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      });
      lastStatus = res.status;
      if (!res.ok) {
        upstreamStatuses.push(res.status);
        const upstreamText = await res.text().catch(() => '');
        let upstreamReason = upstreamText.slice(0, 240);
        try {
          const parsedError = JSON.parse(upstreamText);
          upstreamReason = parsedError.error?.message || parsedError.message || upstreamReason;
        } catch {}
        lastError = new Error(`Gemini upstream HTTP ${res.status}`);
        logEvent('warn', 'ai_upstream_error', {
          requestId,
          model,
          status: res.status,
          reason: upstreamReason.replace(/[\r\n]+/g, ' ').slice(0, 240),
          durationMs: Date.now() - modelStartedAt
        });
        continue;
      }
      const data = await res.json();
      const parsed = extractJson(data.candidates?.[0]?.content?.parts?.[0]?.text);
      let weight = parsed?.weight;
      weight = typeof weight === 'string' ? parseFloat(weight.replace(/[^0-9.]/g, '')) : Number(weight);
      if (!Number.isFinite(weight) || weight <= 0) {
        lastError = new Error('Gemini response did not contain a valid weight');
        logEvent('warn', 'ai_upstream_error', { requestId, model, status: 200, reason: 'invalid_model_payload', durationMs: Date.now() - modelStartedAt });
        continue;
      }
      logEvent('info', 'ai_request_completed', { requestId, model, durationMs: Date.now() - startedAt, hasWeight: true });
      return jsonResponse({ success: true, weight, unit: parsed.unit || '斤', confidence: parsed.confidence || 'high', model }, 200, requestId);
    } catch (err) {
      lastError = err;
      const timedOut = err?.name === 'AbortError';
      if (timedOut) timeoutCount += 1;
      logEvent('warn', 'ai_upstream_error', { requestId, model, reason: timedOut ? 'timeout' : 'network_error', durationMs: Date.now() - modelStartedAt });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  const timedOut = timeoutCount === modelsToTry.length;
  const authFailed = upstreamStatuses.some(status => status === 401 || status === 403);
  const rateLimited = upstreamStatuses.includes(429);
  // A single 400 alongside a timeout/network error is not enough evidence that
  // the image is invalid; otherwise a transient fallback failure is misreported
  // to the user as an image-format problem.
  const badRequest = upstreamStatuses.length > 0 && upstreamStatuses.every(status => status === 400) && timeoutCount === 0;
  const error = timedOut
    ? 'AI_UPSTREAM_TIMEOUT'
    : authFailed
      ? 'AI_AUTH_FAILED'
      : rateLimited
        ? 'AI_RATE_LIMITED'
        : badRequest
          ? 'AI_BAD_REQUEST'
          : 'AI_RECOGNITION_FAILED';
  const message = timedOut
    ? '识别服务响应超时，请稍后重试'
    : authFailed
      ? 'Gemini API Key 无效或已过期，请联系管理员'
      : rateLimited
        ? 'Gemini 服务请求频繁或额度已用尽，请稍后重试'
        : badRequest
          ? '图片格式或内容无法被 Gemini 处理，请重新拍摄'
          : '识别服务暂时不可用，请稍后重试';
  logEvent('error', 'ai_request_failed', { requestId, error, upstreamStatus: lastStatus, durationMs: Date.now() - startedAt });
  return jsonResponse({ error, message }, timedOut ? 504 : 502, requestId);
}
