import { getRecords, saveRecords, uploadPhoto, deleteFile, getFile } from '../github.js';

export async function handleRecordRoutes(request, env, url, session) {
  const path = url.pathname;
  const method = request.method;

  // 1. GET /api/records：读取全部体重记录
  if (path === '/api/records' && method === 'GET') {
    if (!env.GITHUB_TOKEN) {
      return new Response(JSON.stringify({
        error: 'STORAGE_NOT_CONFIGURED',
        message: '未配置 GitHub 访问令牌，无法从私有数据仓库读取数据'
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    let records = [];
    try {
      const res = await getRecords(env);
      if (res && Array.isArray(res.records)) {
        records = res.records;
      }
    } catch (err) {
      console.error('GitHub getRecords error:', err);
      const isAuth = /401|403|Bad credentials|Requires authentication/.test(String(err?.message || ''));
      return new Response(JSON.stringify({
        error: isAuth ? 'GITHUB_AUTH_FAILED' : 'STORAGE_READ_FAILED',
        message: isAuth ? 'GitHub Token 无效或无权限访问私有仓库' : '私有仓库读取失败: ' + err.message
      }), {
        status: isAuth ? 503 : 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify(records), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      }
    });
  }

  // 2. POST /api/records：新增记录（可选附带照片）
  if (path === '/api/records' && method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'INVALID_JSON' }), { status: 400 });
    }

    const { date, time, weight, unit, condition, remark, photoBase64 } = body;
    if (!weight || !date) {
      return new Response(JSON.stringify({ error: 'MISSING_FIELDS', message: '缺少体重或日期' }), { status: 400 });
    }

    const recordDate = new Date(`${date}T${time || '08:00'}:00`);
    const timestamp = !isNaN(recordDate.getTime()) ? recordDate.getTime() : Date.now();
    const yyyy = String(new Date(timestamp).getFullYear());
    const mm = String(new Date(timestamp).getMonth() + 1).padStart(2, '0');
    const recordId = 'wt-' + timestamp;

    let photoPath = '';
    let uploadedSha = null;

    // 写操作严格要求配置 GITHUB_TOKEN
    if (!env.GITHUB_TOKEN) {
      return new Response(JSON.stringify({
        error: 'STORAGE_NOT_CONFIGURED',
        message: '未配置 GitHub Token，无法同步至私有数据仓库'
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }

    // 若提供了 base64 图片则上传照片
    if (photoBase64 && typeof photoBase64 === 'string' && photoBase64.startsWith('data:image')) {
      try {
        const filename = `${recordId}.jpg`;
        const uploadRes = await uploadPhoto(env, yyyy, mm, filename, photoBase64);
        photoPath = uploadRes.path;
        uploadedSha = uploadRes.sha;
      } catch (uploadErr) {
        console.error('Photo upload failed:', uploadErr);
        const githubAuthFailed = /GitHub putFile .* error 401/.test(String(uploadErr?.message || ''));
        return new Response(JSON.stringify({
          error: githubAuthFailed ? 'GITHUB_AUTH_FAILED' : 'PHOTO_UPLOAD_FAILED',
          message: githubAuthFailed
            ? 'GitHub Token 无效或已过期，请重新配置 GITHUB_TOKEN'
            : '秤面照片上传失败: ' + uploadErr.message
        }), { status: githubAuthFailed ? 503 : 500 });
      }
    }

    const newRecord = {
      id: recordId,
      date: date,
      time: time || '08:00',
      weight: parseFloat(weight),
      unit: unit || '斤',
      condition: condition || '早上空腹',
      remark: remark || '',
      photo: photoPath,
      timestamp: timestamp,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    try {
      const { records } = await getRecords(env);
      records.unshift(newRecord);
      await saveRecords(env, records, `Add biometric weight record ${weight}${unit || '斤'} (${date})`);
      return new Response(JSON.stringify({ success: true, record: newRecord }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (saveErr) {
      console.error('Record save failed, triggering rollback:', saveErr);
      // 尽力回滚：若照片已上传，则删除这张孤立照片
      if (photoPath && uploadedSha) {
        try {
          await deleteFile(env, photoPath, uploadedSha, `Rollback orphaned photo ${photoPath}`);
        } catch (rbErr) {
          console.warn('Orphaned photo rollback failed:', rbErr);
        }
      }
      return new Response(JSON.stringify({
        error: 'RECORD_SAVE_FAILED',
        message: '数据写入失败: ' + saveErr.message
      }), { status: 500 });
    }
  }

  // 3. PATCH /api/records/:id：更新记录或替换照片
  const patchMatch = path.match(/^\/api\/records\/([a-zA-Z0-9_-]+)$/);
  const patchTargetId = patchMatch ? patchMatch[1] : (path === '/api/records' ? url.searchParams.get('id') : null);
  if (patchTargetId && method === 'PATCH') {
    if (!env.GITHUB_TOKEN) {
      return new Response(JSON.stringify({
        error: 'STORAGE_NOT_CONFIGURED',
        message: '未配置 GitHub Token，无法同步至私有数据仓库'
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }

    const targetId = patchTargetId;
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'INVALID_JSON' }), { status: 400 });
    }

    const { records } = await getRecords(env);
    const index = records.findIndex(r => r.id === targetId);
    if (index === -1) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND', message: '未找到指定记录' }), { status: 404 });
    }

    const current = records[index];

    // 若提供了替换用的 base64 图片
    if (body.photoBase64 && typeof body.photoBase64 === 'string' && body.photoBase64.startsWith('data:image')) {
      const yyyy = String(new Date(current.timestamp).getFullYear());
      const mm = String(new Date(current.timestamp).getMonth() + 1).padStart(2, '0');
      const filename = `${current.id}.jpg`;
      const uploadRes = await uploadPhoto(env, yyyy, mm, filename, body.photoBase64);
      current.photo = uploadRes.path;
    }

    if (body.weight !== undefined) current.weight = parseFloat(body.weight);
    if (body.date !== undefined) current.date = body.date;
    if (body.time !== undefined) current.time = body.time;
    if (body.condition !== undefined) current.condition = body.condition;
    if (body.remark !== undefined) current.remark = body.remark;
    current.updatedAt = new Date().toISOString();

    records[index] = current;
    await saveRecords(env, records, `Update record ${targetId}`);

    return new Response(JSON.stringify({ success: true, record: current }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 4. DELETE /api/records/:id：删除指定记录
  const delMatch = path.match(/^\/api\/records\/([a-zA-Z0-9_-]+)$/);
  const delTargetId = delMatch ? delMatch[1] : (path === '/api/records' ? url.searchParams.get('id') : null);
  if (delTargetId && method === 'DELETE') {
    const targetId = delTargetId;
    if (!env.GITHUB_TOKEN) {
      return new Response(JSON.stringify({
        error: 'STORAGE_NOT_CONFIGURED',
        message: '未配置 GitHub Token，无法在私有数据仓库删除'
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }

    try {
      const { records } = await getRecords(env);
      const target = records.find(r => r.id === targetId);
      if (!target) {
        return new Response(JSON.stringify({ success: true, id: targetId, message: '记录已在本地移除' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const updated = records.filter(r => r.id !== targetId);
      await saveRecords(env, updated, `Delete record ${targetId}`);

      // 尽力清理私有仓库中关联的照片
      if (target.photo && target.photo.startsWith('images/')) {
        try {
          const photoFile = await getFile(env, target.photo);
          if (photoFile && photoFile.sha) {
            await deleteFile(env, target.photo, photoFile.sha, `Delete associated photo ${target.photo}`);
          }
        } catch (err) {
          console.warn('Failed to delete photo on record delete', err);
        }
      }

      return new Response(JSON.stringify({ success: true, id: targetId }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (delErr) {
      console.error('Delete record failed:', delErr);
      return new Response(JSON.stringify({
        error: 'RECORD_DELETE_FAILED',
        message: '数据删除失败: ' + delErr.message
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  return null;
}