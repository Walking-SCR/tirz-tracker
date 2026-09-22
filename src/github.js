// GitHub REST API 客户端，用于服务端操作私有数据仓库

function getHeaders(env) {
  const token = (
    (env.GITHUB_TOKEN && env.GITHUB_TOKEN.trim()) ||
    (env.GITHUB_PAT && env.GITHUB_PAT.trim()) ||
    (env.GH_TOKEN && env.GH_TOKEN.trim()) ||
    (env.PAT && env.PAT.trim()) ||
    (env.TOKEN && env.TOKEN.trim()) ||
    (env.GITHUB_DATA_TOKEN && env.GITHUB_DATA_TOKEN.trim()) ||
    ''
  );
  const headers = {
    'User-Agent': 'tirz-tracker-cloudflare-worker',
    'Accept': 'application/vnd.github.v3+json'
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

// UTF-8 字符串转 Base64
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
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

// 从 GitHub 获取文件元数据与内容
export async function getFile(env, filePath) {
  const owner = getOwner(env);
  const repo = getDataRepo(env);
  const branch = getBranch(env);

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}&_t=${Date.now()}`;
  const res = await fetch(url, {
    headers: getHeaders(env)
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`GitHub getFile [${filePath}] error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data; // { sha, content, size, path, ... }
}

// 写入或更新 GitHub 文件，遇 409 冲突时自动重试
export async function putFile(env, filePath, contentBase64, commitMessage, sha = null, retryCount = 0) {
  const owner = getOwner(env);
  const repo = getDataRepo(env);
  const branch = getBranch(env);

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
  const body = {
    message: commitMessage,
    content: contentBase64,
    branch: branch
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

  if (res.status === 409 && retryCount < 1) {
    // 409 冲突：说明有其他写入同时发生，重新拉取最新 SHA 后重试一次
    console.warn(`409 Conflict on ${filePath}, retrying once...`);
    const latest = await getFile(env, filePath);
    return await putFile(env, filePath, contentBase64, commitMessage, latest ? latest.sha : null, retryCount + 1);
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
      sha: sha,
      branch: branch
    })
  });
  return res.ok;
}

// 读取体重记录数组
export async function getRecords(env) {
  const file = await getFile(env, 'data/records.json');
  if (!file || !file.content) return { records: [], sha: null };

  try {
    const jsonStr = base64ToUtf8(file.content);
    const parsed = JSON.parse(jsonStr);
    const records = Array.isArray(parsed) ? parsed : (parsed.weights || []);
    return { records, sha: file.sha };
  } catch (err) {
    console.error('Failed to parse records.json', err);
    return { records: [], sha: file.sha };
  }
}

// 保存体重记录数组
export async function saveRecords(env, records, message = 'Update biometric records') {
  const existing = await getFile(env, 'data/records.json');
  const sha = existing ? existing.sha : null;
  let dataToSave;
  if (existing && existing.content) {
    try {
      const parsed = JSON.parse(base64ToUtf8(existing.content));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsed.weights = records;
        parsed.lastUpdated = new Date().toISOString();
        dataToSave = parsed;
      }
    } catch (e) {}
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

// 读取用药记录数组
export async function getDoses(env) {
  const file = await getFile(env, 'data/doses.json');
  if (file && file.content) {
    try {
      const jsonStr = base64ToUtf8(file.content);
      const parsed = JSON.parse(jsonStr);
      const doses = Array.isArray(parsed) ? parsed : (parsed.doses || []);
      if (doses.length > 0) {
        return { doses, sha: file.sha };
      }
    } catch (err) {
      console.error('Failed to parse doses.json', err);
    }
  }

  // 回退：从 records.json 中读取用药数据
  try {
    const recFile = await getFile(env, 'data/records.json');
    if (recFile && recFile.content) {
      const jsonStr = base64ToUtf8(recFile.content);
      const parsed = JSON.parse(jsonStr);
      if (parsed && Array.isArray(parsed.doses) && parsed.doses.length > 0) {
        return { doses: parsed.doses, sha: recFile.sha };
      }
    }
  } catch (err) {
    console.error('Failed to parse fallback doses from records.json', err);
  }

  return { doses: [], sha: file ? file.sha : null };
}

// 保存用药记录数组
export async function saveDoses(env, doses, message = 'Update GLP-1 doses') {
  const existing = await getFile(env, 'data/doses.json');
  const sha = existing ? existing.sha : null;
  const jsonStr = JSON.stringify(doses, null, 2);
  const b64 = utf8ToBase64(jsonStr);
  return await putFile(env, 'data/doses.json', b64, message, sha);
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

// 上传照片，文件扩展名与图片实际 MIME 类型保持一致
export async function uploadPhoto(env, year, month, filename, base64Data) {
  const extension = imageExtensionFromDataUrl(base64Data);
  const baseName = String(filename || 'photo').replace(/\.[a-z0-9]+$/i, '');
  const targetPath = `images/${year}/${month}/${baseName}.${extension}`;
  const pureBase64 = base64Data.replace(/^data:image\/[a-z0-9]+;base64,/, '').replace(/\s/g, '');
  const commitRes = await putFile(env, targetPath, pureBase64, `Upload scale photo ${filename}`);
  return {
    path: targetPath,
    sha: commitRes.content ? commitRes.content.sha : null
  };
}

// 通过 GitHub API 的 JSON 响应安全获取私有照片，避免 302 跨域重定向导致响应头被剥离
export async function fetchPrivatePhoto(env, photoPath) {
  const file = await getFile(env, photoPath);
  if (!file || !file.content) return null;

  const binary = atob(file.content.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const contentType = photoPath.endsWith('.png')
    ? 'image/png'
    : (photoPath.endsWith('.jpg') || photoPath.endsWith('.jpeg'))
      ? 'image/jpeg'
      : (photoPath.endsWith('.heic')
        ? 'image/heic'
        : (photoPath.endsWith('.heif') ? 'image/heif' : 'image/webp'));
  return {
    body: bytes,
    contentType: contentType
  };
}