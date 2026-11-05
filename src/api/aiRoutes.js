// AI 秤面识别路由。
// 主通道：MiniMax-M3（OpenAI 兼容多模态接口，不受调用方地区封锁限制）。
// 回退通道：先 Vertex AI 再公网 Gemini 端点（覆盖 HEIC 直传与 MiniMax 故障场景）。
// 浏览器端永不携带 API Key：密钥仅保存在 Worker Secrets 中。

const MAX_IMAGE_BASE64_LENGTH = 4_000_000;
const UPSTREAM_TIMEOUT_MS = 12_000;
// 浏览器总时限为20秒；服务端最多17秒，并扣除客户端已用时间、预留1.5秒回传。
const TOTAL_UPSTREAM_BUDGET_MS = 17_000;
const RESPONSE_RESERVE_MS = 1_500;
// MiniMax 国内平台（OpenAI 兼容的 Chat Completions 接口）
const MINIMAX_API_URL = 'https://api.minimaxi.com/v1/chat/completions';
const MINIMAX_MODEL = 'MiniMax-M3';
// MiniMax 视觉接口仅支持 JPEG/PNG/GIF/WEBP；HEIC/HEIF 直接走 Gemini 回退链路
const MINIMAX_SUPPORTED_MIME = /^image\/(?:jpeg|png|gif|webp)$/;
const GEMINI_ENDPOINTS = [
  { name: 'vertex', baseUrl: 'https://aiplatform.googleapis.com/v1/publishers/google/models' },
  { name: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models' }
];

function extractJson(text) {
  if (!text) return null;
  const clean = text.trim();
  const normalize = (s) => s.replace(/，/g, ',').replace(/：/g, ':');
  try { return JSON.parse(clean); } catch { }
  try { return JSON.parse(normalize(clean)); } catch { }
  const codeFenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeFenceMatch) {
    try { return JSON.parse(codeFenceMatch[1].trim()); } catch { }
    try { return JSON.parse(normalize(codeFenceMatch[1].trim())); } catch { }
  }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const jsonStr = text.substring(firstBrace, lastBrace + 1);
    try { return JSON.parse(jsonStr); } catch { }
    try { return JSON.parse(normalize(jsonStr)); } catch { }
  }
  const numMatch = text.match(/"(?:raw_value|rawValue|weight)"\s*:\s*"?(\d{2,3}(?:\.\d{1,2})?)"?/) || text.match(/(\d{2,3}(?:\.\d{1,2})?)/);
  return numMatch ? { raw_value: parseFloat(numMatch[1]), raw_unit: 'none', weight: parseFloat(numMatch[1]), unit: '斤' } : null;
}

function parseWeight(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  // 1. 优先提取 raw_value 结合 raw_unit 进行确定性代码数学换算
  let rawVal = parsed.raw_value ?? parsed.rawValue ?? parsed['raw values'] ?? parsed.rawValues;
  if (typeof rawVal === 'string') {
    const numMatch = rawVal.match(/(\d{2,3}(?:\.\d{1,2})?)/);
    rawVal = numMatch ? parseFloat(numMatch[1]) : null;
  } else if (typeof rawVal === 'number' && Number.isFinite(rawVal)) {
    // 合法数值
  } else {
    rawVal = null;
  }

  const rawUnitStr = String(parsed.raw_unit ?? parsed.rawUnit ?? parsed.unit ?? '').toLowerCase().trim();
  const hasKg = /kg|公斤|千克/i.test(rawUnitStr);
  const hasLb = /lb|磅/i.test(rawUnitStr);

  if (rawVal !== null && rawVal > 0) {
    if (rawVal >= 110) return Math.round(rawVal * 10) / 10;
    if (hasKg || (rawVal >= 50 && rawVal <= 105 && !rawUnitStr.includes('斤'))) {
      return Math.round(rawVal * 2 * 10) / 10;
    }
    if (hasLb) return Math.round(rawVal * 0.907 * 10) / 10;
    return Math.round(rawVal * 10) / 10;
  }

  // 2. 兼容直接输出 weight 字段（如 V2 提示词）
  let weight = parsed.weight;
  if (typeof weight === 'string') {
    const numMatch = weight.match(/(\d{2,3}(?:\.\d{1,2})?)/);
    weight = numMatch ? parseFloat(numMatch[1]) : null;
  } else if (typeof weight === 'number' && Number.isFinite(weight)) {
    // 合法数值
  } else {
    weight = null;
  }

  if (weight !== null && weight > 0) {
    // 量程常识纠偏：若模型直接输出 weight 在 55~105 之间，成人体重不可能仅几十斤（系 kg 遗漏换算为斤），自动纠偏为市斤
    if (weight >= 55 && weight <= 105) {
      return Math.round(weight * 2 * 10) / 10;
    }
    return Math.round(weight * 10) / 10;
  }

  return null;
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
  } catch { }
  return reason;
}

function getRemainingUpstreamBudgetMs(startedAt, budgetMs) {
  return Math.max(0, budgetMs - (Date.now() - startedAt));
}

function boundedClientMetric(value, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= max ? Math.round(parsed) : undefined;
}

function isRequestId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value);
}

function shouldUseProviderFallback(status) {
  // 402 表示当前提供商余额/额度不可用，切换供应商仍可能成功。
  return [402, 408, 409, 425, 429].includes(status) || status >= 500;
}

export async function handleAIRoutes(request, env, url, session) {
  if (url.pathname !== '/api/ai/analyze-scale' || request.method !== 'POST') return null;

  const headerRequestId = request.headers.get('X-Request-ID');
  let requestId = isRequestId(headerRequestId) ? headerRequestId : crypto.randomUUID();
  const startedAt = Date.now();
  let body;
  try {
    body = await request.json();
  } catch {
    logEvent('warn', 'ai_request_rejected', { requestId, reason: 'invalid_json' });
    return jsonResponse({ error: 'INVALID_JSON', message: '请求格式不合法' }, 400, requestId);
  }

  if (!isRequestId(headerRequestId) && isRequestId(body?.requestId)) requestId = body.requestId;
  const requestParsedAt = Date.now();
  const clientPrepareMs = boundedClientMetric(body?.clientPrepareMs, 120_000);
  const clientRemainingMs = boundedClientMetric(body?.clientRemainingMs, 20_000);
  const upstreamBudgetMs = Math.max(0, Math.min(
    TOTAL_UPSTREAM_BUDGET_MS,
    (clientRemainingMs ?? Math.max(0, 20_000 - (clientPrepareMs || 0))) - RESPONSE_RESERVE_MS
  ));
  const clientInputBytes = boundedClientMetric(body?.clientInputBytes, 100_000_000);
  const clientImageBytes = boundedClientMetric(body?.clientImageBytes, 10_000_000);
  const clientLastWeight = boundedClientMetric(body?.lastWeight, 500);
  const clientMimeType = typeof body?.clientMimeType === 'string' && /^image\/[a-z0-9.+-]{1,32}$/i.test(body.clientMimeType)
    ? body.clientMimeType.toLowerCase()
    : undefined;

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

  logEvent('info', 'ai_request_started', {
    requestId, mimeType, imageBase64Length: pureBase64.length,
    clientImageBytes, clientInputBytes, clientLastWeight,
    clientMimeType, clientPrepareMs, clientRemainingMs, upstreamBudgetMs, requestParseMs: requestParsedAt - startedAt,
    primary: minimaxKey ? 'minimax' : 'gemini'
  });
  const prompt = [
    '从这张家用电子体重秤照片中识别体重读数。请按以下两步严格执行：',
    '【第一步：空间自适应纠偏与事实提取】',
    '1. 视角与任意角度自适应（支持 0°~360° 任意倾斜、倒置与斜角俯拍）：',
    '   - 用户拍照可能呈任意角度倾斜或带有梯形透视变形，严禁拘泥于正立视角。',
    '   - 请先定位数字排列的主轴线，并以“小数点必然紧贴数字底线/右下角”、发光笔画、或品牌文字/LOGO的正向为物理基准，在心智中校正阅读视角，顺着文字基线从左至右读取。',
    '   - 特别注意点阵屏（如小米体脂秤等由离散发光小圆点构成的LED屏）：数字由点阵拼接而成，照片可能逆时针或顺时针侧立旋转90度，必须整体旋转找正视线方向，严格按正确朝向识别整行数字（例如 162.1 绝不能因侧看错位看成 74.2 或 148.4）。',
    '2. 提取原始数字与单位标识：',
    '   - 提取校正后的原始数字（如 75.0、150.2、162.1）及单位指示（覆盖：kg/公斤、斤/市斤、lb/磅、或无明确单位）。',
    '【第二步：完全穷尽互斥换算为入库单位“斤”】',
    '根据第一步提取的单位，执行且仅执行以下互斥规则之一：',
    '  1. 若单位为 kg/公斤：数值乘以 2 转换为斤；',
    '  2. 若单位为 斤/市斤：数值保持不变；',
    '  3. 若单位为 lb/磅：数值乘以 0.907 转换为斤；',
    '  4. 若屏幕无单位指示：成人体重默认按市斤（保持数值不变）；',
    '  5. 若屏幕显示 Err/Lo/0.0、反光模糊不可辨认、或非秤面照片：数值输出 null。',
    '【输出格式规范】',
    '严格仅返回紧凑合法 JSON，禁止任何解释：{"weight": 换算后的数值或null, "unit": "斤"}。',
    '示例1（任意倾斜/斜拍+kg）：斜向45度俯拍，校准后读到 75.0 kg -> {"weight": 150.0, "unit": "斤"}。',
    '示例2（正常/倒置/侧立+市斤）：读到 168.5 斤 -> {"weight": 168.5, "unit": "斤"}。',
    '示例3（异常）：显示 Err 或反光看不清 -> {"weight": null, "unit": "斤"}。'
  ].join(' ');
  let lastError = null;
  let lastStatus = 502;
  const upstreamStatuses = [];
  const upstreamReasons = [];
  let lastUpstreamReason = '';
  let timeoutCount = 0;
  let attemptCount = 0;
  let useGeminiFallback = true;
  let explicitNullWeightModel = null;
  let minimaxCandidate = null;

  // --- 主通道：MiniMax-M3（HEIC/HEIF 无法解码，直接跳过）---
  if (minimaxKey && MINIMAX_SUPPORTED_MIME.test(mimeType)) {
    const remainingBudgetMs = getRemainingUpstreamBudgetMs(startedAt, upstreamBudgetMs);
    if (remainingBudgetMs > 0) {
      attemptCount += 1;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), Math.min(geminiKey ? UPSTREAM_TIMEOUT_MS : upstreamBudgetMs, remainingBudgetMs));
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
          if (!shouldUseProviderFallback(res.status)) useGeminiFallback = false;
        } else {
          const data = await res.json();
          const parsed = extractJson(data.choices?.[0]?.message?.content);
          if (parsed && typeof parsed === 'object' && (parsed.weight === null || parsed.raw_value === null)) {
            explicitNullWeightModel = MINIMAX_MODEL;
          }
          const weight = parseWeight(parsed);
          if (weight === null) {
            lastError = new Error('MiniMax response did not contain a valid weight');
            logEvent('warn', 'ai_upstream_error', { requestId, endpoint: 'minimax', model: MINIMAX_MODEL, status: 200, reason: 'invalid_model_payload', durationMs: Date.now() - attemptStartedAt });
          } else {
            // 交叉复核机制：若配置了 Gemini 兜底通道且客户端传入了历史最近体重 clientLastWeight，
            // 且 MiniMax 识别数值突变异常（例如相差 > 8 斤，如 162 斤误识为 148.4 斤），
            // 在剩余预算充裕（> 2.5s）时，不盲信 MiniMax，启动 Gemini 交叉复核！
            const isSuspiciousJump = geminiKey && clientLastWeight && Math.abs(weight - clientLastWeight) > 8 && getRemainingUpstreamBudgetMs(startedAt, upstreamBudgetMs) > 2500;
            if (isSuspiciousJump) {
              logEvent('warn', 'ai_suspicious_jump_detected', { requestId, minimaxWeight: weight, clientLastWeight });
              minimaxCandidate = { weight, unit: parsed.unit || '斤', confidence: parsed.confidence || 'high' };
            } else {
              logEvent('info', 'ai_request_completed', { requestId, endpoint: 'minimax', model: MINIMAX_MODEL, durationMs: Date.now() - startedAt, hasWeight: true });
              return jsonResponse({ success: true, weight, unit: parsed.unit || '斤', confidence: parsed.confidence || 'high', model: MINIMAX_MODEL }, 200, requestId);
            }
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
  }

  // --- 回退链路：先经 Vertex AI，再走公网端点 ---
  const modelsToTry = ['gemini-flash-lite-latest'];

  attemptLoop:
  if (useGeminiFallback) for (const endpoint of GEMINI_ENDPOINTS) {
    for (const model of modelsToTry) {
      if (!geminiKey) break attemptLoop;
      const remainingBudgetMs = getRemainingUpstreamBudgetMs(startedAt, upstreamBudgetMs);
      if (remainingBudgetMs <= 0) break attemptLoop;
      attemptCount += 1;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), Math.min(UPSTREAM_TIMEOUT_MS, remainingBudgetMs));
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
          const geoBlockedAtEndpoint = /location is not supported/i.test(lastUpstreamReason);
          const canTryPublicEndpoint = endpoint.name === 'vertex' && (
            [404, 408, 429].includes(res.status) || res.status >= 500 || geoBlockedAtEndpoint
          );
          if (canTryPublicEndpoint) continue;
          break attemptLoop;
        }
        const data = await res.json();
        const parsed = extractJson(data.candidates?.[0]?.content?.parts?.[0]?.text);
        if (parsed && typeof parsed === 'object' && (parsed.weight === null || parsed.raw_value === null)) {
          explicitNullWeightModel = model;
        }
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

  // Enforce the absolute chain deadline even when a previous fallback returned a
  // fast HTTP error and the final attempt consumed the remaining budget.
  const timedOut = getRemainingUpstreamBudgetMs(startedAt, upstreamBudgetMs) === 0
    || (attemptCount > 0 && timeoutCount === attemptCount);
  // "User location is not supported for the API use." —— 上游拒绝的是 Worker 的出口
  // 所在区域，而非图片本身。此处如实上报，不再误判为图片格式问题。
  const geoBlocked = upstreamReasons.some((reason) => /location is not supported/i.test(reason));
  const authFailed = upstreamStatuses.some(status => status === 401 || status === 403);
  const rateLimited = upstreamStatuses.includes(429);
  // 仅有 400 且同时伴随超时/网络错误时，不足以判定图片无效；否则一次偶发的回退
  // 失败会被误报成图片格式问题给到用户。
  const badRequest = upstreamStatuses.length > 0 && upstreamStatuses.every(status => status === 400) && timeoutCount === 0 && !geoBlocked;

  // 模型显式返回 weight: null（无法识别、模糊、Err/Lo代码）时，作为正常业务识别结果返回
  if (explicitNullWeightModel && timeoutCount === 0 && !geoBlocked && !authFailed && !badRequest) {
    logEvent('info', 'ai_request_completed', { requestId, model: explicitNullWeightModel, durationMs: Date.now() - startedAt, hasWeight: false });
    return jsonResponse({ success: true, weight: null, unit: '斤', message: '暂无法识别数字，请更换图片', model: explicitNullWeightModel }, 200, requestId);
  }

  // 若 Gemini 失败或超时，但 MiniMax 此前有备选值，兜底使用 MiniMax 结果
  if (minimaxCandidate) {
    logEvent('info', 'ai_request_completed', { requestId, endpoint: 'minimax', model: MINIMAX_MODEL, durationMs: Date.now() - startedAt, hasWeight: true, fallbackCandidateUsed: true });
    return jsonResponse({ success: true, weight: minimaxCandidate.weight, unit: minimaxCandidate.unit || '斤', confidence: 'medium', model: MINIMAX_MODEL }, 200, requestId);
  }
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
