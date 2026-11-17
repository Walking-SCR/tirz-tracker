// GitHub REST API 客户端，用于服务端操作私有数据仓库

export function getEffectiveGithubToken(env) {
  return (
    (env?.GITHUB_TOKEN && env.GITHUB_TOKEN.trim()) ||
    (env?.GITHUB_PAT && env.GITHUB_PAT.trim()) ||
    (env?.GH_TOKEN && env.GH_TOKEN.trim()) ||
    (env?.PAT && env.PAT.trim()) ||
    (env?.TOKEN && env.TOKEN.trim()) ||
    (env?.GITHUB_DATA_TOKEN && env.GITHUB_DATA_TOKEN.trim()) ||
    ''
  );
}

function getHeaders(env, accept = 'application/vnd.github.v3+json') {
  const token = getEffectiveGithubToken(env);
  const headers = {
    'User-Agent': 'tirz-tracker-cloudflare-worker',
    'Accept': accept
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

function getDataRepo(env) {
  return env.GITHUB_DATA_REPO || env.GITHUB_REPO || 'tirz-tracker-data';
}

function getOwner(env) {
  return env.GITHUB_OWNER || 'Walking-SCR';
}

function getBranch(env) {
  return env.GITHUB_BRANCH || 'main';
}

// UTF-8 字符串转 Base64（分块处理，防止超大 JSON 在 String.fromCharCode 中出现性能或栈上限问题）
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Base64 转 UTF-8 字符串
function base64ToUtf8(b64) {
  const cleanB64 = b64.replace(/\s/g, '');
  const binary = atob(cleanB64);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function isConflictError(err) {
  return /GitHub putFile .* error 409/i.test(String(err?.message || ''));
}

// 从 GitHub 获取文件元数据与内容
export async function getFile(env, filePath) {
  const owner = getOwner(env);
  const repo = getDataRepo(env);
  const branch = getBranch(env);

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}&_t=${Date.now()}`;
  const res = await fetch(url, {
    headers: getHeaders(env)
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`GitHub getFile [${filePath}] error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  // 若文件超过 1MB，GitHub Contents API 返回的 content 为空字符串，需通过 Git Blobs API 拉取完整内容
  if (data && !data.content && data.sha && Number(data.size) > 0) {
    const blobUrl = `https://api.github.com/repos/${owner}/${repo}/git/blobs/${data.sha}`;
    const blobRes = await fetch(blobUrl, { headers: getHeaders(env) });
    if (blobRes.ok) {
      const blobData = await blobRes.json();
      if (blobData?.content) {
        data.content = blobData.content;
      }
    }
  }
  return data; // { sha, content, size, path, ... }
}

// 写入或更新 GitHub 文件（默认不盲目用旧快照覆盖新 SHA，并发合并由业务层 updateRecordsAtomic / updateDosesAtomic 处理）
export async function putFile(env, filePath, contentBase64, commitMessage, sha = null, allowBlindRetry = false) {
  const owner = getOwner(env);
  const repo = getDataRepo(env);
  const branch = getBranch(env);

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
  const body = {
    message: commitMessage,
    content: contentBase64,
    branch
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      ...getHeaders(env),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (res.status === 409 && allowBlindRetry) {
    const latest = await getFile(env, filePath);
    return await putFile(env, filePath, contentBase64, commitMessage, latest ? latest.sha : null, false);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`GitHub putFile [${filePath}] error ${res.status}: ${errText}`);
  }

  return await res.json();
}

// 从 GitHub 删除文件（尽力而为，失败不抛错）
export async function deleteFile(env, filePath, sha, commitMessage = 'Delete file') {
  const owner = getOwner(env);
  const repo = getDataRepo(env);
  const branch = getBranch(env);

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      ...getHeaders(env),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: commitMessage,
      sha,
      branch
    })
  });
  return res.ok;
}

// 读取体重记录数组
export async function getRecords(env) {
  const file = await getFile(env, 'data/records.json');
  if (!file || !file.content) return { records: [], sha: null, rawParsed: null };

  try {
    const jsonStr = base64ToUtf8(file.content);
    const parsed = JSON.parse(jsonStr);
    const records = Array.isArray(parsed) ? parsed : (parsed.weights || []);
    return { records, sha: file.sha, rawParsed: parsed };
  } catch (err) {
    console.error('Failed to parse records.json', err);
    return { records: [], sha: file.sha, rawParsed: null };
  }
}

// 保存体重记录数组
export async function saveRecords(env, records, message = 'Update biometric records', knownSha = null, rawParsed = null) {
  let sha = knownSha;
  let dataToSave;
  if (rawParsed && typeof rawParsed === 'object' && !Array.isArray(rawParsed)) {
    dataToSave = {
      ...rawParsed,
      weights: records,
      lastUpdated: new Date().toISOString()
    };
  } else {
    const existing = knownSha ? null : await getFile(env, 'data/records.json');
    if (existing) sha = existing.sha;
    if (existing && existing.content) {
      try {
        const parsed = JSON.parse(base64ToUtf8(existing.content));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          parsed.weights = records;
          parsed.lastUpdated = new Date().toISOString();
          dataToSave = parsed;
        }
      } catch {}
    }
  }
  if (!dataToSave) {
    dataToSave = {
      version: '2.0',
      lastUpdated: new Date().toISOString(),
      weights: records
    };
  }
  const jsonStr = JSON.stringify(dataToSave, null, 2);
  const b64 = utf8ToBase64(jsonStr);
  return await putFile(env, 'data/records.json', b64, message, sha);
}

// 并发安全的体重记录读-改-写：若遇 GitHub 409 SHA 冲突，重新拉取最新列表并重放 mutator，避免静默丢失并发写入
export async function mutateRecordsWithRetry(env, mutator, commitMessage, initialSnapshot = null, maxRetries = 2) {
  let attempt = 0;
  while (true) {
    const snapshot = (attempt === 0 && initialSnapshot) ? initialSnapshot : await getRecords(env);
    const working = structuredClone(snapshot.records);
    const outcome = await mutator(working);
    if (outcome?.abort) {
      return outcome;
    }
    const nextRecords = outcome?.records ?? working;
    try {
      await saveRecords(env, nextRecords, outcome?.message || commitMessage, snapshot.sha, snapshot.rawParsed);
      return { ...outcome, records: nextRecords };
    } catch (err) {
      if (isConflictError(err) && attempt < maxRetries) {
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
}

// 读取用药记录数组
export async function getDoses(env) {
  const file = await getFile(env, 'data/doses.json');
  if (file && file.content) {
    try {
      const jsonStr = base64ToUtf8(file.content);
      const parsed = JSON.parse(jsonStr);
      const doses = Array.isArray(parsed)
        ? parsed
        : (parsed && Array.isArray(parsed.doses) ? parsed.doses : null);
      if (doses) {
        return { doses, sha: file.sha };
      }
    } catch (err) {
      console.error('Failed to parse doses.json', err);
    }
  }

  return { doses: [], sha: file ? file.sha : null };
}

// 保存用药记录数组，支持复用已知 SHA 消除冗余网络往返
export async function saveDoses(env, doses, message = 'Update GLP-1 doses', knownSha = null) {
  const sha = knownSha !== null ? knownSha : (await getFile(env, 'data/doses.json'))?.sha ?? null;
  const jsonStr = JSON.stringify(doses, null, 2);
  const b64 = utf8ToBase64(jsonStr);
  return await putFile(env, 'data/doses.json', b64, message, sha);
}

// 并发安全的给药记录读-改-写：遇 409 自动基于最新列表重算变更
export async function mutateDosesWithRetry(env, mutator, commitMessage, maxRetries = 2) {
  let attempt = 0;
  while (true) {
    const snapshot = await getDoses(env);
    const working = structuredClone(snapshot.doses);
    const outcome = await mutator(working);
    if (outcome?.abort) {
      return outcome;
    }
    const nextDoses = outcome?.doses ?? working;
    if (outcome?.skipSave) {
      return { ...outcome, doses: nextDoses };
    }
    try {
      await saveDoses(env, nextDoses, outcome?.message || commitMessage, snapshot.sha);
      return { ...outcome, doses: nextDoses };
    } catch (err) {
      if (isConflictError(err) && attempt < maxRetries) {
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
}

// Health data lives in its own private document and never falls back to weight/dose data.
export async function getHealthDocument(env) {
  const file = await getFile(env, 'data/health.json');
  if (!file || !file.content) return { document: null, sha: null };
  try {
    const document = JSON.parse(base64ToUtf8(file.content));
    if (!document || typeof document !== 'object' || !Array.isArray(document.indicators) || !Array.isArray(document.reports)) {
      throw new Error('Invalid health document schema');
    }
    return { document, sha: file.sha };
  } catch (error) {
    throw new Error('HEALTH_DATA_INVALID: ' + error.message, { cause: error });
  }
}

export async function saveHealthDocument(env, document, sha, message = 'Update private health data') {
  const encoded = utf8ToBase64(JSON.stringify(document, null, 2));
  // Do not retry a stale health document with a new SHA; let the caller reload
  // and resolve the concurrent edit instead of overwriting another update.
  return await putFile(env, 'data/health.json', encoded, message, sha, false);
}

function imageExtensionFromDataUrl(base64Data) {
  const match = String(base64Data || '').match(/^data:([^;]+);base64,/i);
  const mime = (match ? match[1] : '').toLowerCase();
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/heic') return 'heic';
  if (mime === 'image/heif') return 'heif';
  return 'webp';
}

function contentTypeFromPhotoPath(photoPath) {
  if (photoPath.endsWith('.png')) return 'image/png';
  if (photoPath.endsWith('.jpg') || photoPath.endsWith('.jpeg')) return 'image/jpeg';
  if (photoPath.endsWith('.heic')) return 'image/heic';
  if (photoPath.endsWith('.heif')) return 'image/heif';
  return 'image/webp';
}

// 上传照片，文件扩展名与图片实际 MIME 类型保持一致（同名文件极低概率碰撞时允许覆盖）
export async function uploadPhoto(env, year, month, filename, base64Data) {
  const extension = imageExtensionFromDataUrl(base64Data);
  const baseName = String(filename || 'photo').replace(/\.[a-z0-9]+$/i, '');
  const targetPath = `images/${year}/${month}/${baseName}.${extension}`;
  const pureBase64 = base64Data.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '').replace(/\s/g, '');
  const commitRes = await putFile(env, targetPath, pureBase64, `Upload scale photo ${filename}`, null, true);
  return {
    path: targetPath,
    sha: commitRes.content ? commitRes.content.sha : null
  };
}

// 安全获取私有照片：兼容 >1MB 大图直接流式拉取二进制（application/vnd.github.raw+json）与 JSON Base64 响应（单测兼容）
export async function fetchPrivatePhoto(env, photoPath) {
  const owner = getOwner(env);
  const repo = getDataRepo(env);
  const branch = getBranch(env);

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${photoPath}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: getHeaders(env, 'application/vnd.github.raw+json')
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`GitHub fetchPrivatePhoto [${photoPath}] error ${res.status}: ${errText}`);
  }

  const respContentType = (res.headers.get('Content-Type') || '').toLowerCase();
  // 若返回的是 GitHub Contents JSON（例如单元测试 mock 或旧接口格式），解码其 base64 content
  if (respContentType.includes('application/json')) {
    const file = await res.json();
    if (!file || !file.content) return null;
    const binary = atob(file.content.replace(/\s/g, ''));
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return {
      body: bytes,
      contentType: contentTypeFromPhotoPath(photoPath)
    };
  }

  // 生产环境下 GitHub raw media type 直接返回原始图片二进制流，突破 1MB Base64 限制并免除 CPU 解码开销
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    body: bytes,
    contentType: contentTypeFromPhotoPath(photoPath)
  };
}
