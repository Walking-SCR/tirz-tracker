import { deleteFile, getFile, getHealthDocument, putFile, uploadPhoto } from '../github.js';
import {
  buildHealthCalendar,
  createEmptyHealthDocument,
  signHealthCalendarVersion,
  validateHealthDate,
  validateHealthTime,
  verifyHealthCalendarVersion
} from '../health.js';

const MAX_IMAGE_BASE64_LENGTH = 4_000_000;
const DATE_TYPES = new Set(['specimen', 'examination', 'report', 'unknown']);
const METRIC_ID = /^[a-z0-9][a-z0-9_-]{1,39}$/;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function privateCalendarResponse(body, status, contentType = 'text/plain; charset=utf-8') {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

async function parseBody(request) {
  if (Number(request.headers.get('Content-Length') || 0) > 6_000_000) return { error: 'PAYLOAD_TOO_LARGE' };
  try { return await request.json(); } catch { return { error: 'INVALID_JSON' }; }
}

async function loadHealth(env) {
  if (!env.GITHUB_TOKEN) return { error: 'STORAGE_NOT_CONFIGURED' };
  try {
    const loaded = await getHealthDocument(env);
    return { document: loaded.document || createEmptyHealthDocument(), sha: loaded.sha };
  } catch (error) {
    console.error(JSON.stringify({ event: 'health_storage_read_failed', kind: String(error?.message || '').startsWith('HEALTH_DATA_INVALID:') ? 'invalid_json' : 'github_error' }));
    return { error: 'HEALTH_STORAGE_READ_FAILED' };
  }
}

async function saveHealth(env, document, sha, expectedRevision, message) {
  if (!Number.isInteger(expectedRevision) || expectedRevision !== document.revision) {
    return jsonResponse({ error: 'REVISION_CONFLICT', message: '健康数据已更新，请刷新后重试', revision: document.revision }, 409);
  }
  if (!env.GITHUB_TOKEN) return jsonResponse({ error: 'STORAGE_NOT_CONFIGURED' }, 503);
  document.revision += 1;
  document.updatedAt = new Date().toISOString();
  const bytes = new TextEncoder().encode(JSON.stringify(document, null, 2));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  try {
    await putFile(env, 'data/health.json', btoa(binary), message, sha, 1);
    return jsonResponse({ success: true, revision: document.revision });
  } catch (error) {
    const detail = String(error?.message || '');
    if (/error (409|422):/i.test(detail)) return jsonResponse({ error: 'REVISION_CONFLICT', message: '健康数据同时被更新，请刷新后重试' }, 409);
    console.error(JSON.stringify({ event: 'health_storage_write_failed', kind: /401|403|Bad credentials|Requires authentication/.test(detail) ? 'github_auth' : 'github_error' }));
    return jsonResponse({ error: 'HEALTH_STORAGE_WRITE_FAILED', message: '私有健康数据保存失败，请重试' }, 502);
  }
}

function normalizeMedicationPlans(input) {
  if (!input || typeof input !== 'object') return null;
  let plans = input;
  if (Array.isArray(input)) {
    if (input.length !== 3 || new Set(input.map(plan => plan?.id)).size !== 3) return null;
    plans = Object.fromEntries(input.map(plan => [plan?.id, plan]));
  }
  const oral = plans.oral;
  const topical = plans.topical;
  const lacquer = plans['nail-lacquer'];
  const valid = Array.isArray(oral?.times) && oral.times.length === 3 && oral.times.every(validateHealthTime)
    && new Set(oral.times).size === 3 && validateHealthDate(oral.startDate)
    && Array.isArray(topical?.times) && topical.times.length === 1
    && validateHealthTime(topical.times[0]) && validateHealthDate(topical.startDate)
    && lacquer?.intervalDays === 3 && validateHealthTime(lacquer.time) && validateHealthDate(lacquer.startDate);
  if (!valid) return null;
  return createEmptyHealthDocument().medicationPlans.map(base => {
    const plan = plans[base.id];
    return {
      ...base,
      ...(base.id === 'nail-lacquer' ? { time: plan.time } : { times: [...plan.times] }),
      startDate: plan.startDate,
      active: plan.active !== false
    };
  });
}

function plansAreConfigured(plans) {
  return normalizeMedicationPlans(plans) !== null;
}

function validateRange(range) {
  if (!range) return null;
  const lower = Number(range.lower);
  const upper = Number(range.upper);
  return Number.isFinite(lower) && Number.isFinite(upper) && lower < upper ? { lower, upper } : false;
}

function validateObservation(row, indicators) {
  const metric = indicators.find(item => item.id === row?.metricId || item.code === row?.metricCode);
  const value = Number(row?.value);
  const range = validateRange(row?.referenceRange);
  return !!metric && Number.isFinite(value) && value >= 0
    && typeof row.unit === 'string' && row.unit.trim().length > 0 && row.unit.length <= 20
    && range !== false;
}

function reportsAreValid(report, indicators) {
  if (!report || !Array.isArray(report.observations) || report.observations.length === 0 || report.observations.length > 24) return false;
  if (report.reportDate != null && !validateHealthDate(report.reportDate)) return false;
  if (report.examDate != null && !validateHealthDate(report.examDate)) return false;
  if (report.dateConfirmed && !['specimen', 'examination', 'report'].includes(report.dateType)) return false;
  if (!DATE_TYPES.has(report.dateType)) return false;
  if (report.dateConfirmed && !(report.examDate || report.reportDate)) return false;
  return report.observations.every(row => validateObservation(row, indicators));
}

function extractModelJson(text) {
  if (!text) return null;
  try { return JSON.parse(text.trim()); } catch {}
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function normalizeDateCandidates(candidates) {
  if (!Array.isArray(candidates)) return [];
  return candidates.slice(0, 8).map(candidate => ({
    value: validateHealthDate(candidate?.value) ? candidate.value : null,
    type: DATE_TYPES.has(candidate?.type) ? candidate.type : 'unknown',
    rawLabel: String(candidate?.rawLabel || '').slice(0, 60)
  })).filter(candidate => candidate.value);
}

async function analyzeReport(request, env, session) {
  if (!session) return jsonResponse({ error: 'AUTH_REQUIRED', message: '登录后才能识别私有检查报告' }, 401);
  const body = await parseBody(request);
  if (body.error) return jsonResponse({ error: body.error }, 400);
  if (typeof body.imageBase64 !== 'string' || !body.imageBase64) return jsonResponse({ error: 'MISSING_IMAGE' }, 400);
  const mime = body.imageBase64.match(/^data:(image\/(?:jpeg|jpg|png|webp|heic|heif));base64,/i);
  if (!mime) return jsonResponse({ error: 'UNSUPPORTED_IMAGE_TYPE' }, 415);
  const image = body.imageBase64.replace(/^data:[^;]+;base64,/i, '').replace(/\s/g, '');
  if (image.length < 100) return jsonResponse({ error: 'INVALID_IMAGE' }, 400);
  if (image.length > MAX_IMAGE_BASE64_LENGTH) return jsonResponse({ error: 'IMAGE_TOO_LARGE' }, 413);
  const apiKey = typeof env.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY.trim() : '';
  if (!apiKey) return jsonResponse({ error: 'AI_NOT_CONFIGURED', message: '报告识别服务暂未配置' }, 503);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12_000);
  try {
    const prompt = [
      '你是一个专业的医疗检验报告单结构化数据提取引擎。请对上传的化验单/检验报告单图片进行高精度数字化识别，严格遵守 MECE 原则（相互独立、完全穷尽），按以下四个步骤执行，最终仅返回合法 JSON：',
      '',
      '【第一步：图像方向校正与区域锚定】',
      '1. 360° 全向自适应校正：若图片旋转（90°/180°/270°）、俯拍倾斜或存在透视畸变，请先以单据顶部的医院抬头、检验科名称、横向分割线及表格表头（“项目名称/结果/参考范围/单位”）确定正向阅读基准。',
      '2. 行对齐防串行：沿表格横向水平基准线阅读，锁定同一数据行。严禁将上下相邻行的数值或参考范围错位套用。若文字被红色公章、折痕压盖，请穿透底色识别打印字体；完全遮挡无法辨认的直接忽略。',
      '',
      '【第二步：日期实体提取与互斥分类（完全穷尽 4 种类型）】',
      '从报告单的页眉、页脚及基本信息栏中提取所有相关日期，格式统一标准化为 "YYYY-MM-DD"（忽略具体时分秒），并严格按印制前缀进行语义分类：',
      '- specimen（标本采样）：前缀包含“采样时间”、“采集日期”、“采血时间”、“抽血时间”等。',
      '- examination（检验接收）：前缀包含“接收时间”、“送检日期”、“检验时间”、“测定时间”、“分析时间”等。',
      '- report（报告发布）：前缀包含“报告时间”、“审核日期”、“核对时间”、“打印日期”等。',
      '- unknown（未知类型）：单据上印有明确日期但前缀仅为“日期/时间”或无法明确对应上述三种流程。',
      '【反例排除】：出生日期、就诊/挂号日期、病历建立日期、软件系统版权年份严禁作为化验日期提取。',
      '',
      '【第三步：目标肝酶指标提取与槽位清洗】',
      '仅提取以下已配置的两种肝酶指标（其他无关指标忽略），严格提取 6 个结构化槽位：',
      '1. metricCode（标准代码）：仅限 "ALT" 或 "AST"。',
      '   - ALT 别名：ALT、谷丙转氨酶、丙氨酸氨基转移酶、GPT、ALAT。',
      '   - AST 别名：AST、谷草转氨酶、天门冬氨酸氨基转移酶、GOT、ASAT。',
      '   - 【互斥排除】：严禁提取“AST/ALT比值”、“谷草/谷丙比值”等复合比值！严禁提取 ALP（碱性磷酸酶）、GGT（谷氨酰转肽酶）等其他酶类。',
      '2. sourceLabel：单据上打印的项目原始名称（如“丙氨酸氨基转移酶”）。',
      '3. value：纯测定数值（浮点数或整数，如 86.5）。必须彻底剥离附带的箭头、正负号、星号、字母标记。',
      '4. unit：单据打印的测定单位（如 "U/L"、"IU/L"）。',
      '5. referenceRange：参考范围对象。若为双边区间（如 "9-50"、"9~50"），提取为 {"lower": 9, "upper": 50}；若仅有单边上限（如 "<50"、"<=50"），提取为 {"lower": 0, "upper": 50}；若无参考范围或缺失则填 null。',
      '6. printedFlag：打印的高低/异常标记（如 "↑", "↓", "H", "L", "*", "+" 或文字“偏高”），无任何标记则输出空字符串 ""。',
      '',
      '【第四步：格式规范与安全边界】',
      '1. 严禁下达医疗诊断、分析病情、解释偏高偏低原因或提供用药建议。',
      '2. 严禁推测或臆造任何模糊不清、部分裁剪的数值。',
      '3. 严格仅输出标准 JSON，禁止包含任何 Markdown 格式说明（如 ```json ... ```）或冗余问候语。',
      'Schema: {"dateCandidates":[{"value":"YYYY-MM-DD","type":"specimen|examination|report|unknown","rawLabel":"printed label"}],"observations":[{"metricCode":"ALT|AST","sourceLabel":"printed test name","value":number,"unit":"printed unit","referenceRange":{"lower":number,"upper":number},"printedFlag":"printed flag or empty"}]}'
    ].join('\n');
    const response = await fetch('https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-flash-lite-latest:generateContent', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: mime[1].toLowerCase().replace('image/jpg', 'image/jpeg'), data: image } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 1200 }
      })
    });
    if (!response.ok) return jsonResponse({ error: response.status === 429 ? 'AI_RATE_LIMITED' : 'AI_RECOGNITION_FAILED', message: '报告识别暂不可用，请稍后重试或手动录入' }, response.status === 429 ? 503 : 502);
    const payload = await response.json();
    const parsed = extractModelJson(payload?.candidates?.[0]?.content?.parts?.[0]?.text);
    if (!parsed || !Array.isArray(parsed.observations)) return jsonResponse({ error: 'AI_BAD_RESPONSE', message: '未能读取报告字段，请手动核对' }, 502);
    const observations = parsed.observations.slice(0, 24).flatMap(row => {
      const metricCode = String(row?.metricCode || '').toUpperCase();
      const value = Number(row?.value);
      if (!['ALT', 'AST'].includes(metricCode) || !Number.isFinite(value) || value < 0 || typeof row.unit !== 'string') return [];
      const referenceRange = validateRange(row.referenceRange);
      return [{
        metricCode,
        sourceLabel: String(row.sourceLabel || '').slice(0, 80),
        value,
        unit: row.unit.slice(0, 20),
        referenceRange,
        printedFlag: String(row.printedFlag || '').slice(0, 30)
      }];
    });
    return jsonResponse({ success: true, reviewRequired: true, extraction: { dateCandidates: normalizeDateCandidates(parsed.dateCandidates), observations } });
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    return jsonResponse({ error: timedOut ? 'AI_UPSTREAM_TIMEOUT' : 'AI_RECOGNITION_FAILED', message: timedOut ? '识别超时，请稍后重试或手动录入' : '报告识别暂不可用，请手动核对' }, timedOut ? 504 : 502);
  } finally {
    clearTimeout(timeoutId);
  }
}

function calendarUrl(origin, version, signature, protocol) {
  const url = new URL('/api/health/calendar.ics', origin);
  url.searchParams.set('version', String(version));
  url.searchParams.set('signature', signature);
  if (protocol === 'webcal:') url.protocol = 'webcal:';
  return url.toString();
}

async function calendarFeed(request, env, url) {
  const version = Number(url.searchParams.get('version'));
  const signature = url.searchParams.get('signature') || '';
  const signingKey = String(env.AUTH_SIGNING_KEY || '').trim();
  if (!signingKey || !await verifyHealthCalendarVersion(signingKey, version, signature)) {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  const loaded = await loadHealth(env);
  if (loaded.error) return new Response('Calendar unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  const health = loaded.document || createEmptyHealthDocument();
  if (!health.calendar?.active || health.calendar.version !== version) {
    return new Response('Subscription revoked', { status: 410, headers: { 'Cache-Control': 'no-store' } });
  }
  return new Response(buildHealthCalendar(health, url.origin), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="health.ics"',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export async function handleHealthRoutes(request, env, url, session) {
  const path = url.pathname;
  const method = request.method;
  if (path === '/api/health/calendar.ics' && method === 'GET') return calendarFeed(request, env, url);
  if (path !== '/api/health' && !path.startsWith('/api/health/')) return null;
  if (!session) return jsonResponse({ error: 'AUTH_REQUIRED', message: '登录后才能访问或修改健康记录' }, 401);

  if (path === '/api/health/analyze' && method === 'POST') return analyzeReport(request, env, session);
  if (path === '/api/health/reports/analyze' && method === 'POST') return analyzeReport(request, env, session);

  const loaded = await loadHealth(env);
  if (loaded.error) return jsonResponse({ error: loaded.error, message: '私有健康数据暂不可读取' }, loaded.error === 'STORAGE_NOT_CONFIGURED' ? 503 : 502);
  const health = loaded.document || createEmptyHealthDocument();
  const sha = loaded.sha;

  if (path === '/api/health' && (method === 'GET' || method === 'HEAD')) {
    return jsonResponse({ ...health, storage: { source: 'private-github', synced: true } });
  }

  if (path === '/api/health/calendar-link' && method === 'GET') {
    if (!health.calendar?.active) return jsonResponse({ error: 'CALENDAR_SYNC_DISABLED', message: '健康日历同步已暂停' }, 409);
    const signingKey = String(env.AUTH_SIGNING_KEY || '').trim();
    if (!signingKey) return jsonResponse({ error: 'AUTH_NOT_CONFIGURED' }, 503);
    const signature = await signHealthCalendarVersion(signingKey, health.calendar.version);
    return jsonResponse({
      httpsUrl: calendarUrl(url.origin, health.calendar.version, signature, 'https:'),
      webcalUrl: calendarUrl(url.origin, health.calendar.version, signature, 'webcal:'),
      version: health.calendar.version,
      requiresIphoneConfirmation: true,
      configured: plansAreConfigured(health.medicationPlans)
    });
  }

  if (path === '/api/health' && method === 'PUT') {
    const body = await parseBody(request);
    if (body.error) return jsonResponse({ error: body.error }, 400);
    if (body.action === 'save-plans') {
      const normalizedPlans = normalizeMedicationPlans(body.medicationPlans);
      if (!normalizedPlans) return jsonResponse({ error: 'INVALID_MEDICATION_PLAN', message: '请为三类计划填写有效时间和开始日期' }, 400);
      health.medicationPlans = normalizedPlans;
    } else if (body.action === 'confirm-calendar') {
      health.calendar.userConfirmedAt = new Date().toISOString();
    } else if (body.action === 'stop-calendar') {
      health.calendar.active = false;
      health.calendar.userConfirmedAt = null;
      health.calendar.version += 1;
      health.calendar.updatedAt = new Date().toISOString();
    } else if (body.action === 'resume-calendar') {
      health.calendar.active = true;
      health.calendar.version += 1;
      health.calendar.userConfirmedAt = null;
    } else {
      return jsonResponse({ error: 'INVALID_HEALTH_ACTION' }, 400);
    }
    return saveHealth(env, health, sha, body.expectedRevision, 'Update private health plan');
  }

  if (path === '/api/health/reports' && method === 'POST') {
    const body = await parseBody(request);
    if (body.error) return jsonResponse({ error: body.error }, 400);
    if (!reportsAreValid(body.report, health.indicators.filter(item => !item.deletedAt))) return jsonResponse({ error: 'INVALID_REPORT', message: '请核对日期、数值、单位和参考范围' }, 400);
    const report = {
      id: 'lab-' + crypto.randomUUID(),
      sourceOrder: health.reports.reduce((max, row) => Math.max(max, Number(row.sourceOrder) || 0), 0) + 1,
      createdAt: new Date().toISOString(),
      reportDate: body.report.reportDate || null,
      examDate: body.report.examDate || null,
      dateType: body.report.dateType,
      dateConfirmed: body.report.dateConfirmed === true,
      remarks: String(body.report.remarks || '').slice(0, 120),
      observations: body.report.observations.map(row => ({
        metricId: row.metricId,
        metricCode: health.indicators.find(item => item.id === row.metricId || item.code === row.metricId)?.code || null,
        sourceLabel: String(row.sourceLabel || '').slice(0, 80),
        value: Number(row.value),
        unit: row.unit.trim(),
        referenceRange: row.referenceRange ? { lower: Number(row.referenceRange.lower), upper: Number(row.referenceRange.upper) } : null,
        printedFlag: String(row.printedFlag || '').slice(0, 30)
      })),
      photoPath: null
    };

    if (body.photoBase64) {
      const image = String(body.photoBase64);
      const mime = image.match(/^data:image\/(jpeg|png|webp|heic|heif);base64,/i);
      const pure = image.replace(/^data:[^;]+;base64,/i, '').replace(/\s/g, '');
      if (!mime || pure.length < 100 || pure.length > MAX_IMAGE_BASE64_LENGTH) return jsonResponse({ error: 'INVALID_REPORT_IMAGE' }, 400);
      const year = String(new Date().getUTCFullYear());
      const month = String(new Date().getUTCMonth() + 1).padStart(2, '0');
      try {
        report.photoPath = (await uploadPhoto(env, 'health', year + '/' + month, report.id, image)).path;
      } catch {
        return jsonResponse({ error: 'REPORT_IMAGE_UPLOAD_FAILED', message: '报告图片未保存，本次记录未入库' }, 502);
      }
    }

    health.reports.push(report);
    const saved = await saveHealth(env, health, sha, body.expectedRevision, 'Add private liver report ' + report.id);
    if (saved.status >= 400 && report.photoPath) {
      try {
        const imageFile = await getFile(env, report.photoPath);
        if (imageFile?.sha) await deleteFile(env, report.photoPath, imageFile.sha, 'Rollback orphaned health report image');
      } catch {}
    }
    return saved.status >= 400 ? saved : jsonResponse({ success: true, report, revision: health.revision });
  }

  const reportMatch = path.match(/^\/api\/health\/reports\/([a-z0-9_-]+)$/);
  if (reportMatch && method === 'PATCH') {
    const body = await parseBody(request);
    if (body.error) return jsonResponse({ error: body.error }, 400);
    const index = health.reports.findIndex(report => report.id === reportMatch[1]);
    if (index < 0) return jsonResponse({ error: 'REPORT_NOT_FOUND' }, 404);
    const current = health.reports[index];
    const updated = {
      ...current,
      reportDate: body.report?.reportDate !== undefined ? body.report.reportDate : current.reportDate,
      examDate: body.report?.examDate !== undefined ? body.report.examDate : current.examDate,
      dateType: body.report?.dateType !== undefined ? body.report.dateType : current.dateType,
      dateConfirmed: body.report?.dateConfirmed === true,
      remarks: body.report?.remarks !== undefined ? String(body.report.remarks || '').slice(0, 120) : current.remarks,
      observations: body.report?.observations || current.observations
    };
    if (!reportsAreValid(updated, health.indicators.filter(item => !item.deletedAt))) {
      return jsonResponse({ error: 'INVALID_REPORT', message: '请核对日期类型、指标数值、单位和参考范围' }, 400);
    }
    let newPhotoPath = null;
    if (body.photoBase64) {
      const image = String(body.photoBase64);
      const mime = image.match(/^data:image\/(jpeg|png|webp|heic|heif);base64,/i);
      const pure = image.replace(/^data:[^;]+;base64,/i, '').replace(/\s/g, '');
      if (!mime || pure.length < 100 || pure.length > MAX_IMAGE_BASE64_LENGTH) return jsonResponse({ error: 'INVALID_REPORT_IMAGE' }, 400);
      try {
        const year = String(new Date().getUTCFullYear());
        const month = String(new Date().getUTCMonth() + 1).padStart(2, '0');
        newPhotoPath = (await uploadPhoto(env, 'health', year + '/' + month, updated.id + '-' + crypto.randomUUID(), image)).path;
        updated.photoPath = newPhotoPath;
      } catch {
        return jsonResponse({ error: 'REPORT_IMAGE_UPLOAD_FAILED' }, 502);
      }
    }
    health.reports[index] = updated;
    const saved = await saveHealth(env, health, sha, body.expectedRevision, 'Update private health report ' + updated.id);
    if (saved.status >= 400) {
      if (newPhotoPath) {
        try { const photo = await getFile(env, newPhotoPath); if (photo?.sha) await deleteFile(env, newPhotoPath, photo.sha, 'Rollback health report image update'); } catch {}
      }
      return saved;
    }
    if (newPhotoPath && current.photoPath && current.photoPath !== newPhotoPath) {
      try { const old = await getFile(env, current.photoPath); if (old?.sha) await deleteFile(env, current.photoPath, old.sha, 'Replace private health report image'); } catch {}
    }
    return jsonResponse({ success: true, report: updated, revision: health.revision });
  }

  if (reportMatch && method === 'DELETE') {
    const body = await parseBody(request);
    if (body.error) return jsonResponse({ error: body.error }, 400);
    if (body.confirmDelete !== true) return jsonResponse({ error: 'CONFIRMATION_REQUIRED' }, 400);
    const report = health.reports.find(item => item.id === reportMatch[1]);
    if (!report) return jsonResponse({ error: 'REPORT_NOT_FOUND' }, 404);
    health.reports = health.reports.filter(item => item.id !== report.id);
    const saved = await saveHealth(env, health, sha, body.expectedRevision, 'Delete private health report ' + report.id);
    if (saved.status >= 400) return saved;
    if (report.photoPath && /^images\/health\/\d{4}\/\d{2}\/[a-zA-Z0-9_.-]+$/.test(report.photoPath)) {
      try { const photo = await getFile(env, report.photoPath); if (photo?.sha) await deleteFile(env, report.photoPath, photo.sha, 'Delete private health report image'); } catch {}
    }
    return jsonResponse({ success: true, id: report.id, deletedObservations: report.observations?.length || 0, revision: health.revision });
  }

  if (path === '/api/health/indicators' && method === 'POST') {
    const body = await parseBody(request);
    if (body.error) return jsonResponse({ error: body.error }, 400);
    const input = body.indicator || {};
    if (!METRIC_ID.test(String(input.id || '')) || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 50 || typeof input.unit !== 'string' || !input.unit.trim() || input.unit.length > 20) {
      return jsonResponse({ error: 'INVALID_INDICATOR' }, 400);
    }
    if (health.indicators.some(item => item.id === input.id)) return jsonResponse({ error: 'INDICATOR_EXISTS' }, 409);
    const indicator = { id: input.id, code: null, label: input.label.trim(), aliases: [], unit: input.unit.trim(), visible: true, deletedAt: null };
    health.indicators.push(indicator);
    const saved = await saveHealth(env, health, sha, body.expectedRevision, 'Add private health indicator');
    return saved.status >= 400 ? saved : jsonResponse({ success: true, indicator, revision: health.revision });
  }

  const indicatorMatch = path.match(/^\/api\/health\/indicators\/([a-z0-9_-]+)$/);
  if (indicatorMatch && method === 'PATCH') {
    const body = await parseBody(request);
    if (body.error) return jsonResponse({ error: body.error }, 400);
    const indicator = health.indicators.find(item => item.id === indicatorMatch[1] && !item.deletedAt);
    if (!indicator) return jsonResponse({ error: 'INDICATOR_NOT_FOUND' }, 404);
    if (typeof body.visible === 'boolean') indicator.visible = body.visible;
    if (typeof body.label === 'string' && body.label.trim()) indicator.label = body.label.trim().slice(0, 50);
    const saved = await saveHealth(env, health, sha, body.expectedRevision, 'Update private health indicator');
    return saved.status >= 400 ? saved : jsonResponse({ success: true, indicator, revision: health.revision });
  }

  if (indicatorMatch && method === 'DELETE') {
    const body = await parseBody(request);
    if (body.error) return jsonResponse({ error: body.error }, 400);
    if (body.confirmDelete !== true) return jsonResponse({ error: 'CONFIRMATION_REQUIRED' }, 400);
    const indicator = health.indicators.find(item => item.id === indicatorMatch[1] && !item.deletedAt);
    if (!indicator) return jsonResponse({ error: 'INDICATOR_NOT_FOUND' }, 404);
    const count = health.reports.reduce((sum, report) => sum + report.observations.filter(row => row.metricId === indicator.id || row.metricCode === indicator.code).length, 0);
    health.reports = health.reports.map(report => ({ ...report, observations: report.observations.filter(row => row.metricId !== indicator.id && row.metricCode !== indicator.code) }));
    health.indicators = health.indicators.filter(item => item.id !== indicator.id);
    const saved = await saveHealth(env, health, sha, body.expectedRevision, 'Delete private health metric and observations');
    return saved.status >= 400 ? saved : jsonResponse({ success: true, deletedObservations: count, revision: health.revision });
  }

  if (path === '/api/health/tasks' && method === 'POST') {
    const body = await parseBody(request);
    if (body.error) return jsonResponse({ error: body.error }, 400);
    if (!['oral', 'topical', 'nail-lacquer'].includes(body.planId) || !validateHealthDate(body.date) || !validateHealthTime(body.time) || !['complete', 'undo', 'snooze'].includes(body.action)) {
      return jsonResponse({ error: 'INVALID_TASK_ACTION' }, 400);
    }
    if (!health.medicationPlans.some(plan => plan.id === body.planId && plan.active !== false)) return jsonResponse({ error: 'PLAN_NOT_FOUND' }, 404);
    if (!Array.isArray(health.taskCompletions)) health.taskCompletions = [];
    const id = body.planId + ':' + body.date + ':' + body.time;
    if (body.action === 'undo') {
      health.taskCompletions = health.taskCompletions.filter(task => task.id !== id);
    } else if (body.action === 'snooze') {
      if (![5, 10, 15, 30].includes(Number(body.minutes))) return jsonResponse({ error: 'INVALID_SNOOZE' }, 400);
      const task = { id, planId: body.planId, date: body.date, time: body.time, status: 'snoozed', snoozedUntil: new Date(Date.now() + Number(body.minutes) * 60_000).toISOString(), updatedAt: new Date().toISOString() };
      health.taskCompletions = health.taskCompletions.filter(item => item.id !== id).concat(task);
    } else {
      const task = { id, planId: body.planId, date: body.date, time: body.time, status: 'done', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      health.taskCompletions = health.taskCompletions.filter(item => item.id !== id).concat(task);
    }
    const saved = await saveHealth(env, health, sha, body.expectedRevision, 'Update private health task');
    return saved.status >= 400 ? saved : jsonResponse({ success: true, task: health.taskCompletions.find(item => item.id === id) || null, revision: health.revision });
  }

  return null;
}
