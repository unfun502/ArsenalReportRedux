import { getAssetFromKV } from '@cloudflare/kv-asset-handler';

addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event));
});

async function handleRequest(event) {
  try {
    const response = await getAssetFromKV(event);

    // Apply security headers
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

    return new Response(response.body, {
      status: response.status,
      headers,
    });
  } catch (e) {
    // Serve index.html for SPA-style fallback
    try {
      const notFoundResponse = await getAssetFromKV(event, {
        mapRequestToAsset: (req) =>
          new Request(`${new URL(req.url).origin}/index.html`, req),
      });
      return new Response(notFoundResponse.body, {
        ...notFoundResponse,
        status: 200,
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  }
}
