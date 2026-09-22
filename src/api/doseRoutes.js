import { getDoses, saveDoses } from '../github.js';

export async function handleDoseRoutes(request, env, url, session) {
  const path = url.pathname;
  const method = request.method;

  // 1. GET /api/doses：读取全部针剂记录
  if (path === '/api/doses' && (method === 'GET' || method === 'HEAD')) {
    if (!env.GITHUB_TOKEN) {
      return new Response(JSON.stringify({
        error: 'STORAGE_NOT_CONFIGURED',
        message: '未配置 GitHub 访问令牌，无法从私有数据仓库读取针剂记录'
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }

   let doses = [];
   try {
     const res = await getDoses(env);
     if (res && Array.isArray(res.doses)) {
        doses = res.doses.map(d => ({ ...d, intervalDays: d.intervalDays || 7 }));
     }
   } catch (err) {
      console.error('GitHub getDoses error:', err);
      return new Response(JSON.stringify({
        error: 'STORAGE_READ_FAILED',
        message: '获取针剂记录失败: ' + err.message
      }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify(doses), {
      headers: {
        'Content-Type': 'application/json',
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
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }

   let body;
   try {
     body = await request.json();
   } catch {
     return new Response(JSON.stringify({ error: 'INVALID_JSON' }), { status: 400 });
   }

    const { seq, amount, date, time, weight, site, remark, intervalDays } = body;
    const timestamp = new Date(`${date}T${time || '20:00'}:00`).getTime();
    const newDose = {
      id: 'dose-' + (timestamp || Date.now()),
      seq: seq || '给药记录',
      amount: amount || '2.5mg',
      date: date,
      time: time || '20:00',
      weight: parseFloat(weight) || 0,
      site: site || '腹部',
      intervalDays: parseInt(intervalDays, 10) || 7,
      remark: remark || '',
      timestamp: timestamp,
      createdAt: new Date().toISOString()
    };

   const { doses } = await getDoses(env);
   doses.push(newDose);
   await saveDoses(env, doses, `Add dose record ${seq} (${amount})`);

   return new Response(JSON.stringify({ success: true, dose: newDose }), {
     headers: { 'Content-Type': 'application/json' }
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
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'INVALID_JSON' }), { status: 400 });
    }

    const { doses } = await getDoses(env);
    const index = doses.findIndex(d => d.id === patchTargetId);
    if (index === -1) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND', message: '未找到指定给药记录' }), { status: 404 });
    }

    const current = doses[index];
    if (body.seq !== undefined) current.seq = body.seq;
    if (body.amount !== undefined) current.amount = body.amount;
    if (body.date !== undefined) current.date = body.date;
    if (body.time !== undefined) current.time = body.time;
    if (body.weight !== undefined) current.weight = parseFloat(body.weight) || 0;
    if (body.site !== undefined) current.site = body.site;
    if (body.remark !== undefined) current.remark = body.remark;
    if (body.intervalDays !== undefined) current.intervalDays = parseInt(body.intervalDays, 10) || 7;

    if (body.date !== undefined || body.time !== undefined) {
      const dt = new Date(`${current.date}T${current.time || '20:00'}:00`);
      if (!isNaN(dt.getTime())) {
        current.timestamp = dt.getTime();
      }
    }
    current.updatedAt = new Date().toISOString();

    doses[index] = current;
    await saveDoses(env, doses, `Update dose record ${patchTargetId}`);

    return new Response(JSON.stringify({ success: true, dose: current }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 3. DELETE /api/doses/:id：删除指定针剂记录
  const delMatch = path.match(/^\/api\/doses\/([a-zA-Z0-9_-]+)$/);
  const delTargetId = delMatch ? delMatch[1] : (path === '/api/doses' ? url.searchParams.get('id') : null);
  if (delTargetId && method === 'DELETE') {
    if (!env.GITHUB_TOKEN) {
      return new Response(JSON.stringify({
        error: 'STORAGE_NOT_CONFIGURED',
        message: '未配置 GitHub Token，无法删除针剂记录'
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }

    const targetId = delTargetId;
    try {
      const { doses } = await getDoses(env);
      const updated = doses.filter(d => d.id !== targetId);

      // 删除请求必须落到 data/doses.json；目标已不存在时保持幂等，
      // 这样客户端重试不会因为 404 把待同步队列卡住。
      if (updated.length !== doses.length) {
        await saveDoses(env, updated, `Delete dose ${targetId}`);
      }

      return new Response(JSON.stringify({
        success: true,
        id: targetId,
        deleted: updated.length !== doses.length
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (err) {
      console.error('GitHub delete dose error:', err);
      return new Response(JSON.stringify({
        error: 'STORAGE_DELETE_FAILED',
        message: '删除针剂记录失败: ' + err.message
      }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
  }

  return null;
}
