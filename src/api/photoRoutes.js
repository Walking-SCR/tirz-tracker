import { fetchPrivatePhoto } from '../github.js';

export async function handlePhotoRoutes(request, env, url, session) {
  const path = url.pathname;
  const method = request.method;

  // 匹配 /api/photos/2026/09/wt-xxxx.webp 或 /api/photos/images/2026/09/wt-xxxx.webp
  const photoMatch = path.match(/^\/api\/photos\/(?:(health)\/)?(?:images\/)?(\d{4})\/(\d{2})\/([a-zA-Z0-9_.-]+)$/);
  if (photoMatch && (method === 'GET' || method === 'HEAD')) {
    const [, healthRoot, yyyy, mm, filename] = photoMatch;
    const photoPath = healthRoot
      ? ['images', 'health', yyyy, mm, filename].join('/')
      : ['images', yyyy, mm, filename].join('/');

    // 边缘缓存优化：若命中 Cloudflare 边缘缓存，直接返回，规避 GitHub API 频率限制与延迟
    const cache = (typeof caches !== 'undefined' && caches && caches.default) ? caches.default : null;
    if (cache && method === 'GET') {
      try {
        const cached = await cache.match(request);
        if (cached) return cached;
      } catch (e) {}
    }

    if (!env.GITHUB_TOKEN) {
      return new Response('GitHub token not configured', { status: 503 });
    }

    try {
      let result = await fetchPrivatePhoto(env, photoPath);
      if (!result) {
        const baseName = filename.replace(/\.[a-z0-9]+$/i, '');
        const currentExt = (filename.match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase();
        // 性能优化：优先探测高频扩展名 (.jpg, .png)，避免 5 次深度串行试探阻塞
        const altExts = ['.jpg', '.png', '.webp', '.jpeg'].filter(ext => ext !== currentExt);
        for (const ext of altExts) {
          const altPath = healthRoot ? ['images', 'health', yyyy, mm, baseName + ext].join('/') : ['images', yyyy, mm, baseName + ext].join('/');
          result = await fetchPrivatePhoto(env, altPath);
          if (result) break;
        }
      }

      if (result) {
        const response = new Response(result.body, {
          headers: {
            'Content-Type': result.contentType || 'image/jpeg',
            'Cache-Control': 'private, max-age=604800, immutable',
            'X-Content-Type-Options': 'nosniff'
          }
        });

        // 异步缓存至边缘，加速后续相同照片请求
        if (cache && method === 'GET') {
          try {
            const cacheResponse = new Response(result.body, {
              headers: {
                'Content-Type': result.contentType || 'image/jpeg',
                'Cache-Control': 'public, max-age=604800, immutable',
                'X-Content-Type-Options': 'nosniff'
              }
            });
            cache.put(request, cacheResponse).catch(() => {});
          } catch (e) {}
        }

        return response;
      }
    } catch (err) {
      console.warn('GitHub photo fetch failed:', err);
      return new Response('Error fetching photo from private repository', { status: 502 });
    }

    return new Response('Photo not found in private repository', { status: 404 });
  }

  return null;
}
