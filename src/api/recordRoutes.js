import { getRecords, mutateRecordsWithRetry, uploadPhoto, deleteFile, getFile } from '../github.js';

// 统一按东八区（Asia/Shanghai, UTC+8）计算时间戳与年月目录，消除 Cloudflare Worker 默认 UTC 导致的跨天/8小时偏差
function parseShanghaiTimestamp(dateStr, timeStr = '08:00') {
  const safeDate = String(dateStr || '').trim();
  const safeTime = String(timeStr || '08:00').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(safeDate) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(safeTime)) {
    const ms = Date.parse(`${safeDate}T${safeTime}:00+08:00`);
    if (Number.isFinite(ms)) return ms;
  }
  const fallback = new Date(`${safeDate}T${safeTime}:00`);
  return !isNaN(fallback.getTime()) ? fallback.getTime() : Date.now();
}

function extractYearMonth(dateStr, timestamp) {
  const match = String(dateStr || '').match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (match) {
    return { yyyy: match[1], mm: match[2] };
  }
  const shanghaiDate = new Date(timestamp + 8 * 3600 * 1000);
  return {
    yyyy: String(shanghaiDate.getUTCFullYear()),
    mm: String(shanghaiDate.getUTCMonth() + 1).padStart(2, '0')
  };
}

export async function handleRecordRoutes(request, env, url, session, ctx) {
  const path = url.pathname;
  const method = request.method;

  // 1. GET /api/records：读取全部体重记录
  if (path === '/api/records' && (method === 'GET' || method === 'HEAD')) {
    if (!env.GITHUB_TOKEN) {
      return new Response(JSON.stringify({
        error: 'STORAGE_NOT_CONFIGURED',
        message: '未配置 GitHub 访问令牌，无法从私有数据仓库读取数据'
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    let records = [];
    try {
      const res = await getRecords(env);
      if (res && Array.isArray(res.records)) {
        records = res.records;
      }
    } catch (err) {
      console.error('GitHub getRecords error:', err?.message || 'unknown');
      const isAuth = /401|403|Bad credentials|Requires authentication/.test(String(err?.message || ''));
      return new Response(JSON.stringify({
        error: isAuth ? 'GITHUB_AUTH_FAILED' : 'STORAGE_READ_FAILED',
        message: isAuth ? 'GitHub Token 无效或无权限访问私有仓库' : '私有仓库读取失败，请稍后重试'
      }), {
        status: isAuth ? 503 : 502,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    return new Response(JSON.stringify(records), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
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
      return new Response(JSON.stringify({ error: 'INVALID_JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const { date, time, weight, unit, condition, remark, photoBase64 } = body || {};
    const numericWeight = Number(weight);
    if (!Number.isFinite(numericWeight) || numericWeight <= 0 || numericWeight > 1000 || !date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return new Response(JSON.stringify({ error: 'MISSING_FIELDS', message: '缺少有效的体重或日期' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const clientTimestamp = Number(body.timestamp);
    const timestamp = (Number.isFinite(clientTimestamp) && clientTimestamp > 0)
      ? clientTimestamp
      : parseShanghaiTimestamp(date, time || '08:00');
    const { yyyy, mm } = extractYearMonth(date, timestamp);
    const recordId = (typeof body.id === 'string' && /^wt-[a-zA-Z0-9_-]{1,40}$/.test(body.id))
      ? body.id
      : 'wt-' + timestamp;

    let photoPath = '';
    let uploadedSha = null;

    if (!env.GITHUB_TOKEN) {
      return new Response(JSON.stringify({
        error: 'STORAGE_NOT_CONFIGURED',
        message: '未配置 GitHub Token，无法同步至私有数据仓库'
      }), { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    // 性能优化：照片上传与 records.json 元数据读取并行发起，减少一次网络往返时延
    const photoUploadPromise = (photoBase64 && typeof photoBase64 === 'string' && photoBase64.startsWith('data:image'))
      ? uploadPhoto(env, yyyy, mm, `${recordId}.jpg`, photoBase64)
      : Promise.resolve(null);
    const recordsPromise = getRecords(env);

    try {
      const uploadRes = await photoUploadPromise;
      if (uploadRes) {
        photoPath = uploadRes.path;
        uploadedSha = uploadRes.sha;
      }
    } catch (uploadErr) {
      console.error('Photo upload failed:', uploadErr?.message || 'unknown');
      const githubAuthFailed = /GitHub putFile .* error 401/.test(String(uploadErr?.message || ''));
      return new Response(JSON.stringify({
        error: githubAuthFailed ? 'GITHUB_AUTH_FAILED' : 'PHOTO_UPLOAD_FAILED',
        message: githubAuthFailed
          ? 'GitHub Token 无效或已过期，请重新配置 GITHUB_TOKEN'
          : '秤面照片上传失败，请稍后重试'
      }), { status: githubAuthFailed ? 503 : 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    const nowIso = new Date().toISOString();
    const newRecord = {
      id: recordId,
      date: String(date),
      time: typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : '08:00',
      weight: Math.round(numericWeight * 10) / 10,
      unit: typeof unit === 'string' && unit.trim() ? unit.trim().slice(0, 10) : '斤',
      condition: typeof condition === 'string' && condition.trim() ? condition.trim().slice(0, 24) : '早上空腹',
      remark: typeof remark === 'string' ? remark.slice(0, 120) : '',
      photo: photoPath,
      timestamp,
      createdAt: nowIso,
      updatedAt: nowIso
    };

    try {
      const initialSnapshot = await recordsPromise;
      await mutateRecordsWithRetry(env, (records) => {
        const filtered = records.filter(r => r.id !== newRecord.id);
        filtered.unshift(newRecord);
        filtered.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        return { records: filtered };
      }, `Add biometric weight record ${newRecord.weight}${newRecord.unit} (${newRecord.date})`, initialSnapshot);

      return new Response(JSON.stringify({ success: true, record: newRecord }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    } catch (saveErr) {
      console.error('Record save failed, triggering rollback:', saveErr?.message || 'unknown');
      if (photoPath && uploadedSha) {
        try {
          await deleteFile(env, photoPath, uploadedSha, `Rollback orphaned photo ${photoPath}`);
        } catch (rbErr) {
          console.warn('Orphaned photo rollback failed:', rbErr?.message || 'unknown');
        }
      }
      return new Response(JSON.stringify({
        error: 'RECORD_SAVE_FAILED',
        message: '数据写入失败，请稍后重试'
      }), { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
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
      }), { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    const targetId = patchTargetId;
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'INVALID_JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const initialSnapshot = await getRecords(env);
    const existingTarget = initialSnapshot.records.find(r => r.id === targetId);
    if (!existingTarget) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND', message: '未找到指定记录' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    let uploadedPhotoPath = null;
    if (body?.photoBase64 && typeof body.photoBase64 === 'string' && body.photoBase64.startsWith('data:image')) {
      const { yyyy, mm } = extractYearMonth(body.date || existingTarget.date, existingTarget.timestamp || Date.now());
      const uploadRes = await uploadPhoto(env, yyyy, mm, `${existingTarget.id}.jpg`, body.photoBase64);
      uploadedPhotoPath = uploadRes.path;
    }

    const outcome = await mutateRecordsWithRetry(env, (records) => {
      const index = records.findIndex(r => r.id === targetId);
      if (index === -1) return { abort: true, notFound: true };

      const current = records[index];
      if (uploadedPhotoPath) current.photo = uploadedPhotoPath;
      if (body.weight !== undefined) {
        const w = Number(body.weight);
        if (Number.isFinite(w) && w > 0) current.weight = Math.round(w * 10) / 10;
      }
      if (typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) current.date = body.date;
      if (typeof body.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.time)) current.time = body.time;
      if (typeof body.condition === 'string') current.condition = body.condition.trim().slice(0, 24);
      if (typeof body.remark === 'string') current.remark = body.remark.slice(0, 120);

      if (body.date !== undefined || body.time !== undefined) {
        current.timestamp = parseShanghaiTimestamp(current.date, current.time || '08:00');
      }
      current.updatedAt = new Date().toISOString();

      records[index] = current;
      records.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      return { records, updatedRecord: current };
    }, `Update record ${targetId}`, initialSnapshot);

    if (outcome?.notFound) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND', message: '未找到指定记录' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    return new Response(JSON.stringify({ success: true, record: outcome.updatedRecord }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
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
      }), { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    try {
      let deletedPhoto = '';
      const outcome = await mutateRecordsWithRetry(env, (records) => {
        const target = records.find(r => r.id === targetId);
        if (!target) {
          return { abort: true, alreadyDeleted: true };
        }
        deletedPhoto = target.photo || '';
        return { records: records.filter(r => r.id !== targetId) };
      }, `Delete record ${targetId}`);

      if (outcome?.alreadyDeleted) {
        return new Response(JSON.stringify({ success: true, id: targetId, message: '记录已在本地移除' }), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      }

      if (deletedPhoto && deletedPhoto.startsWith('images/')) {
        const cleanupPhoto = async () => {
          try {
            const photoFile = await getFile(env, deletedPhoto);
            if (photoFile && photoFile.sha) {
              await deleteFile(env, deletedPhoto, photoFile.sha, `Delete associated photo ${deletedPhoto}`);
            }
          } catch (err) {
            console.warn('Failed to delete photo on record delete', err?.message || 'unknown');
          }
        };
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(cleanupPhoto());
        } else if (session && typeof session.waitUntil === 'function') {
          session.waitUntil(cleanupPhoto());
        } else {
          cleanupPhoto().catch(() => {});
        }
      }

      return new Response(JSON.stringify({ success: true, id: targetId }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    } catch (delErr) {
      console.error('Delete record failed:', delErr?.message || 'unknown');
      return new Response(JSON.stringify({
        error: 'RECORD_DELETE_FAILED',
        message: '数据删除失败，请稍后重试'
      }), { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
  }

  return null;
}
