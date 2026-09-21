import { fetchPrivatePhoto } from '../github.js';

export async function handlePhotoRoutes(request, env, url, session) {
  const path = url.pathname;
  const method = request.method;

  // Match /api/photos/2026/09/wt-xxxx.webp or /api/photos/images/2026/09/wt-xxxx.webp
  const photoMatch = path.match(/^\/api\/photos\/(?:images\/)?(\d{4})\/(\d{2})\/([a-zA-Z0-9_.-]+)$/);
  if (photoMatch && (method === 'GET' || method === 'HEAD')) {
    const [, yyyy, mm, filename] = photoMatch;
    const photoPath = `images/${yyyy}/${mm}/${filename}`;

    try {
      if (env.GITHUB_TOKEN) {
        const result = await fetchPrivatePhoto(env, photoPath);
        if (result) {
          return new Response(result.body, {
            headers: {
              'Content-Type': result.contentType || 'image/webp',
              'Cache-Control': 'public, max-age=86400',
              'X-Content-Type-Options': 'nosniff'
            }
          });
        }
      }
    } catch (err) {
      console.warn('GitHub photo fetch failed, trying local assets fallback:', err);
    }

    // Fallback to static assets if available
    if (env.ASSETS) {
      const candidates = [photoPath];
      if (filename.endsWith('.webp')) {
        candidates.push(`images/${yyyy}/${mm}/${filename.replace(/\.webp$/, '.png')}`);
      } else if (filename.endsWith('.png')) {
        candidates.push(`images/${yyyy}/${mm}/${filename.replace(/\.png$/, '.webp')}`);
      }

      for (const candidate of candidates) {
        try {
          const assetUrl = new URL(`/${candidate}`, request.url);
          const assetRes = await env.ASSETS.fetch(new Request(assetUrl, request));
          if (assetRes && assetRes.status < 400) {
            const contentType = candidate.endsWith('.png') ? 'image/png' : 'image/webp';
            const headers = new Headers(assetRes.headers);
            headers.set('Content-Type', contentType);
            headers.set('Cache-Control', 'public, max-age=86400');
            headers.set('X-Content-Type-Options', 'nosniff');
            return new Response(assetRes.body, {
              status: assetRes.status,
              headers
            });
          }
        } catch (assetErr) {
          console.warn('Asset fetch error:', assetErr);
        }
      }
    }

    return new Response('Photo not found', { status: 404 });
  }

  return null;
}
