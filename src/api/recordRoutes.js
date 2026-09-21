import { getRecords, saveRecords, uploadPhoto, deleteFile, getFile } from '../github.js';

export async function handleRecordRoutes(request, env, url, session) {
  const path = url.pathname;
  const method = request.method;

  // 1. GET /api/records
  if (path === '/api/records' && method === 'GET') {
    let records = [];
    try {
      const res = await getRecords(env);
      if (res && Array.isArray(res.records) && res.records.length > 0) {
        records = res.records;
      }
    } catch (err) {
      console.warn('GitHub getRecords error, trying fallback:', err);
    }

    // Fallback to static asset records if empty
    if (!records || records.length === 0) {
      if (env.ASSETS) {
        try {
          const assetRes = await env.ASSETS.fetch(new Request(new URL('/data/records.json', request.url)));
          if (assetRes && assetRes.status === 200) {
            const data = await assetRes.json();
            records = Array.isArray(data) ? data : (data.weights || []);
          }
        } catch (e) {}
      }
    }

    return new Response(JSON.stringify(records), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 2. POST /api/records (Create new record with optional photo)
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

    // Upload photo if base64 provided
    if (photoBase64 && typeof photoBase64 === 'string' && photoBase64.startsWith('data:image')) {
      try {
        const filename = `${recordId}.webp`;
        const uploadRes = await uploadPhoto(env, yyyy, mm, filename, photoBase64);
        photoPath = uploadRes.path;
        uploadedSha = uploadRes.sha;
      } catch (uploadErr) {
        console.error('Photo upload failed:', uploadErr);
        return new Response(JSON.stringify({
          error: 'PHOTO_UPLOAD_FAILED',
          message: '秤面照片上传失败: ' + uploadErr.message
        }), { status: 500 });
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

    if (!env.GITHUB_TOKEN) {
      return new Response(JSON.stringify({
        success: true,
        record: newRecord,
        cloudSync: false,
        message: '未配置 GitHub Token，记录已保存在本地但未同步到私有仓库'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      const { records } = await getRecords(env);
      records.unshift(newRecord);
      await saveRecords(env, records, `Add biometric weight record ${weight}${unit || '斤'} (${date})`);
      return new Response(JSON.stringify({ success: true, record: newRecord }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (saveErr) {
      console.error('Record save failed, triggering rollback:', saveErr);
      // Best-effort rollback: delete orphaned photo if created
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

  // 3. PATCH /api/records/:id (Update or replace photo)
  const patchMatch = path.match(/^\/api\/records\/([a-zA-Z0-9_-]+)$/);
  const patchTargetId = patchMatch ? patchMatch[1] : (path === '/api/records' ? url.searchParams.get('id') : null);
  if (patchTargetId && method === 'PATCH') {
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

    // If replacement photo base64 provided
    if (body.photoBase64 && typeof body.photoBase64 === 'string' && body.photoBase64.startsWith('data:image')) {
      const yyyy = String(new Date(current.timestamp).getFullYear());
      const mm = String(new Date(current.timestamp).getMonth() + 1).padStart(2, '0');
      const filename = `${current.id}.webp`;
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

  // 4. DELETE /api/records/:id
  const delMatch = path.match(/^\/api\/records\/([a-zA-Z0-9_-]+)$/);
  const delTargetId = delMatch ? delMatch[1] : (path === '/api/records' ? url.searchParams.get('id') : null);
  if (delTargetId && method === 'DELETE') {
    const targetId = delTargetId;
    if (!env.GITHUB_TOKEN) {
      return new Response(JSON.stringify({ success: true, id: targetId, cloudSync: false }), {
        headers: { 'Content-Type': 'application/json' }
      });
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

      // Clean up associated photo from private repo if exists (best effort)
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
