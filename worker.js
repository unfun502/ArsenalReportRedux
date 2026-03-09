import { getAssetFromKV } from '@cloudflare/kv-asset-handler';
import manifestJSON from '__STATIC_CONTENT_MANIFEST';

const assetManifest = JSON.parse(manifestJSON);

const POSTGREST_BASE = 'https://api.devlab502.net/arsenal';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' fonts.googleapis.com",
    "font-src fonts.gstatic.com",
    "img-src 'self' cdn.devlab502.net data:",
    "connect-src 'self'",
  ].join('; '),
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API proxy: /api/* → PostgREST (GET only, public read)
    if (url.pathname.startsWith('/api/')) {
      return handleApiProxy(url);
    }

    // Static assets via Workers Sites (KV)
    try {
      const response = await getAssetFromKV(
        { request, waitUntil: ctx.waitUntil.bind(ctx) },
        { ASSET_NAMESPACE: env.__STATIC_CONTENT, ASSET_MANIFEST: assetManifest }
      );

      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);

      return new Response(response.body, { status: response.status, headers });
    } catch {
      // SPA fallback
      try {
        const fallback = await getAssetFromKV(
          { request, waitUntil: ctx.waitUntil.bind(ctx) },
          {
            ASSET_NAMESPACE: env.__STATIC_CONTENT,
            ASSET_MANIFEST: assetManifest,
            mapRequestToAsset: req =>
              new Request(`${new URL(req.url).origin}/index.html`, req),
          }
        );
        const headers = new Headers(fallback.headers);
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
        return new Response(fallback.body, { status: 200, headers });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    }
  },
};

async function handleApiProxy(url) {
  const pgPath = url.pathname.replace(/^\/api/, '');
  const pgUrl  = POSTGREST_BASE + pgPath + (url.search || '');

  const pgResponse = await fetch(pgUrl, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });

  const body = await pgResponse.text();

  return new Response(body, {
    status: pgResponse.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
