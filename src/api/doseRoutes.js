import { getDoses, saveDoses } from '../github.js';

export async function handleDoseRoutes(request, env, url, session) {
  const path = url.pathname;
  const method = request.method;

  // 1. GET /api/doses
  if (path === '/api/doses' && method === 'GET') {
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
        doses = res.doses;
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

  // 2. POST /api/doses
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

    const { seq, amount, date, time, weight, site } = body;
    const timestamp = new Date(`${date}T${time || '20:00'}:00`).getTime();
    const newDose = {
      id: 'dose-' + (timestamp || Date.now()),
      seq: seq || '给药记录',
      amount: amount || '2.5ml',
      date: date,
      time: time || '20:00',
      weight: parseFloat(weight) || 0,
      site: site || '腹部',
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

  // 3. DELETE /api/doses/:id
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
    const { doses } = await getDoses(env);
    const updated = doses.filter(d => d.id !== targetId);
    await saveDoses(env, updated, `Delete dose ${targetId}`);
    return new Response(JSON.stringify({ success: true, id: targetId }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return null;
}
