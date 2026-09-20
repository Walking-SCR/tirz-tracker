import { fetchPrivatePhoto } from '../github.js';

export async function handlePhotoRoutes(request, env, url, session) {
  const path = url.pathname;
  const method = request.method;

  // Match /api/photos/2026/09/wt-xxxx.webp or /api/photos/images/2026/09/wt-xxxx.webp
  const photoMatch = path.match(/^\/api\/photos\/(?:images\/)?(\d{4})\/(\d{2})\/([a-zA-Z0-9_.-]+)$/);
  if (photoMatch && method === 'GET') {
    const [, yyyy, mm, filename] = photoMatch;
    const photoPath = `images/${yyyy}/${mm}/${filename}`;

    try {
      const result = await fetchPrivatePhoto(env, photoPath);
      if (!result) {
        return new Response('Photo not found', { status: 404 });
      }

      return new Response(result.body, {
        headers: {
          'Content-Type': result.contentType || 'image/webp',
          'Cache-Control': 'private, no-store, must-revalidate',
          'X-Content-Type-Options': 'nosniff'
        }
      });
    } catch (err) {
      console.error('Failed to proxy photo:', err);
      return new Response('Photo fetch failed', { status: 500 });
    }
  }

  return null;
}
