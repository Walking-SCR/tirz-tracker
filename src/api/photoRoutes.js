import { fetchPrivatePhoto } from '../github.js';

export async function handlePhotoRoutes(request, env, url, session) {
  const path = url.pathname;
  const method = request.method;

  // 匹配 /api/photos/2026/09/wt-xxxx.webp 或 /api/photos/images/2026/09/wt-xxxx.webp
  const photoMatch = path.match(/^\/api\/photos\/(?:images\/)?(\d{4})\/(\d{2})\/([a-zA-Z0-9_.-]+)$/);
  if (photoMatch && (method === 'GET' || method === 'HEAD')) {
    const [, yyyy, mm, filename] = photoMatch;
    const photoPath = `images/${yyyy}/${mm}/${filename}`;

    if (!env.GITHUB_TOKEN) {
      return new Response('GitHub token not configured', { status: 503 });
    }

    try {
      let result = await fetchPrivatePhoto(env, photoPath);
      if (!result) {
        const baseName = filename.replace(/\.[a-z0-9]+$/i, '');
        const currentExt = (filename.match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase();
        const altExts = ['.jpg', '.png', '.webp', '.jpeg', '.heic'].filter(ext => ext !== currentExt);
        for (const ext of altExts) {
          result = await fetchPrivatePhoto(env, `images/${yyyy}/${mm}/${baseName}${ext}`);
          if (result) break;
        }
      }

      if (result) {
        return new Response(result.body, {
          headers: {
            'Content-Type': result.contentType || 'image/jpeg',
            'Cache-Control': 'private, max-age=86400',
            'X-Content-Type-Options': 'nosniff'
          }
        });
      }
    } catch (err) {
      console.warn('GitHub photo fetch failed:', err);
      return new Response('Error fetching photo from private repository', { status: 502 });
    }

    return new Response('Photo not found in private repository', { status: 404 });
  }

  return null;
}
