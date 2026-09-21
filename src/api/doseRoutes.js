import { getDoses, saveDoses } from '../github.js';

export async function handleDoseRoutes(request, env, url, session) {
  const path = url.pathname;
  const method = request.method;

  const clientToken = request.headers.get('X-GitHub-Token');
  if (clientToken && !env.GITHUB_TOKEN) {
    env._clientToken = clientToken;
  }

  // 1. GET /api/doses
  if (path === '/api/doses' && method === 'GET') {
    let doses = [];
    try {
      const res = await getDoses(env);
      if (res && Array.isArray(res.doses) && res.doses.length > 0) {
        doses = res.doses;
      }
    } catch (err) {
      console.warn('GitHub getDoses error, trying fallback:', err);
    }

    // Fallback to static asset doses if empty
    if (!doses || doses.length === 0) {
      if (env.ASSETS) {
        try {
          const assetRes = await env.ASSETS.fetch(new Request(new URL('/data/doses.json', request.url)));
          if (assetRes && assetRes.status === 200) {
            const data = await assetRes.json();
            doses = Array.isArray(data) ? data : (data.doses || []);
          }
        } catch (e) {}
      }
    }

    return new Response(JSON.stringify(doses), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 2. POST /api/doses
  if (path === '/api/doses' && method === 'POST') {
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
