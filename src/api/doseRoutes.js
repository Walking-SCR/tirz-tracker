import { getDoses, mutateDosesWithRetry } from '../github.js';

function parseShanghaiTimestamp(dateStr, timeStr = '20:00') {
  const safeDate = String(dateStr || '').trim();
  const safeTime = String(timeStr || '20:00').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(safeDate) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(safeTime)) {
    const ms = Date.parse(`${safeDate}T${safeTime}:00+08:00`);
    if (Number.isFinite(ms)) return ms;
  }
  const fallback = new Date(`${safeDate}T${safeTime}:00`);
  return !isNaN(fallback.getTime()) ? fallback.getTime() : Date.now();
}

export async function handleDoseRoutes(request, env, url, session) {
  const path = url.pathname;
  const method = request.method;

  // 1. GET /api/doses：读取全部针剂记录
  if (path === '/api/doses' && (method === 'GET' || method === 'HEAD')) {
    if (!env.GITHUB_TOKEN) {
      return new Response(JSON.stringify({
        error: 'STORAGE_NOT_CONFIGURED',
        message: '未配置 GitHub 访问令牌，无法从私有数据仓库读取针剂记录'
      }), { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    let doses = [];
    try {
      const res = await getDoses(env);
      if (res && Array.isArray(res.doses)) {
        doses = res.doses.map(d => ({ ...d, intervalDays: d.intervalDays || 7 }));
      }
    } catch (err) {
      console.error('GitHub getDoses error:', err?.message || 'unknown');
      return new Response(JSON.stringify({
        error: 'STORAGE_READ_FAILED',
        message: '获取针剂记录失败，请稍后重试'
      }), { status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    return new Response(JSON.stringify(doses), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      }
    });
  }

  // 2. POST /api/doses：新增针剂记录
  if (path === '/api/doses' && method === 'POST') {
    if (!env.GITHUB_TOKEN) {
      return new Response(JSON.stringify({
        error: 'STORAGE_NOT_CONFIGURED',
        message: '未配置 GitHub Token，无法保存针剂记录'
      }), { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'INVALID_JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const { seq, amount, date, time, weight, site, remark, intervalDays } = body || {};
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return new Response(JSON.stringify({ error: 'MISSING_FIELDS', message: '缺少有效的给药日期' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }
    const safeTime = typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : '20:00';
    const timestamp = parseShanghaiTimestamp(date, safeTime);
    const parsedInterval = Math.min(90, Math.max(1, parseInt(intervalDays, 10) || 7));
    const newDose = {
      id: (typeof body.id === 'string' && /^dose-[a-zA-Z0-9_-]{1,40}$/.test(body.id)) ? body.id : 'dose-' + (timestamp || Date.now()),
      seq: typeof seq === 'string' && seq.trim() ? seq.trim().slice(0, 30) : '给药记录',
      amount: typeof amount === 'string' && amount.trim() ? amount.trim().slice(0, 20) : '2.5mg',
      date: String(date),
      time: safeTime,
      weight: parseFloat(weight) || 0,
      site: typeof site === 'string' && site.trim() ? site.trim().slice(0, 20) : '腹部',
      intervalDays: parsedInterval,
      remark: typeof remark === 'string' ? remark.slice(0, 120) : '',
      timestamp,
      createdAt: new Date().toISOString()
    };

    await mutateDosesWithRetry(env, (doses) => {
      const filtered = doses.filter(d => d.id !== newDose.id);
      filtered.push(newDose);
      return { doses: filtered };
    }, `Add dose record ${newDose.seq} (${newDose.amount})`);

    return new Response(JSON.stringify({ success: true, dose: newDose }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  // 3. PATCH /api/doses/:id：更新指定针剂记录
  const patchMatch = path.match(/^\/api\/doses\/([a-zA-Z0-9_-]+)$/);
  const patchTargetId = patchMatch ? patchMatch[1] : (path === '/api/doses' ? url.searchParams.get('id') : null);
  if (patchTargetId && method === 'PATCH') {
    if (!env.GITHUB_TOKEN) {
      return new Response(JSON.stringify({
        error: 'STORAGE_NOT_CONFIGURED',
        message: '未配置 GitHub Token，无法更新针剂记录'
      }), { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'INVALID_JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const outcome = await mutateDosesWithRetry(env, (doses) => {
      const index = doses.findIndex(d => d.id === patchTargetId);
      if (index === -1) return { abort: true, notFound: true };

      const current = doses[index];
      if (typeof body.seq === 'string') current.seq = body.seq.trim().slice(0, 30);
      if (typeof body.amount === 'string') current.amount = body.amount.trim().slice(0, 20);
      if (typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) current.date = body.date;
      if (typeof body.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.time)) current.time = body.time;
      if (body.weight !== undefined) current.weight = parseFloat(body.weight) || 0;
      if (typeof body.site === 'string') current.site = body.site.trim().slice(0, 20);
      if (typeof body.remark === 'string') current.remark = body.remark.slice(0, 120);
      if (body.intervalDays !== undefined) current.intervalDays = Math.min(90, Math.max(1, parseInt(body.intervalDays, 10) || 7));

      if (body.date !== undefined || body.time !== undefined) {
        current.timestamp = parseShanghaiTimestamp(current.date, current.time || '20:00');
      }
      current.updatedAt = new Date().toISOString();

      doses[index] = current;
      return { doses, updatedDose: current };
    }, `Update dose record ${patchTargetId}`);

    if (outcome?.notFound) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND', message: '未找到指定给药记录' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    return new Response(JSON.stringify({ success: true, dose: outcome.updatedDose }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  // 4. DELETE /api/doses/:id：删除指定针剂记录
  const delMatch = path.match(/^\/api\/doses\/([a-zA-Z0-9_-]+)$/);
  const delTargetId = delMatch ? delMatch[1] : (path === '/api/doses' ? url.searchParams.get('id') : null);
  if (delTargetId && method === 'DELETE') {
    if (!env.GITHUB_TOKEN) {
      return new Response(JSON.stringify({
        error: 'STORAGE_NOT_CONFIGURED',
        message: '未配置 GitHub Token，无法删除针剂记录'
      }), { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    const targetId = delTargetId;
    try {
      const outcome = await mutateDosesWithRetry(env, (doses) => {
        const updated = doses.filter(d => d.id !== targetId);
        const deleted = updated.length !== doses.length;
        return { doses: updated, deleted, skipSave: !deleted };
      }, `Delete dose ${targetId}`);

      return new Response(JSON.stringify({
        success: true,
        id: targetId,
        deleted: Boolean(outcome.deleted)
      }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    } catch (err) {
      console.error('GitHub delete dose error:', err?.message || 'unknown');
      return new Response(JSON.stringify({
        error: 'STORAGE_DELETE_FAILED',
        message: '删除针剂记录失败，请稍后重试'
      }), { status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
  }

  return null;
}
