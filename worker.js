import { getAssetFromKV } from '@cloudflare/kv-asset-handler';
import manifestJSON from '__STATIC_CONTENT_MANIFEST';

const assetManifest = JSON.parse(manifestJSON);

const POSTGREST_BASE = 'https://api.devlab502.net/arsenal';
const CLERK_JWKS_URL = 'https://learning-grouper-25.clerk.accounts.dev/.well-known/jwks.json';
const ADMIN_USER_ID  = 'user_3AdbnJCmquM3NDsW2glzfLxYvGB';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' cdnjs.cloudflare.com https://learning-grouper-25.clerk.accounts.dev analytics.devlab502.net https://browser.sentry-cdn.com",
    "style-src 'self' 'unsafe-inline' fonts.googleapis.com",
    "font-src fonts.gstatic.com",
    "img-src 'self' cdn.devlab502.net data: https://img.clerk.com",
    "connect-src 'self' https://learning-grouper-25.clerk.accounts.dev https://clerk.learning-grouper-25.clerk.accounts.dev analytics.devlab502.net https://*.ingest.us.sentry.io",
    "frame-src https://learning-grouper-25.clerk.accounts.dev https://accounts.google.com",
  ].join('; '),
};

// In-memory JWKS cache (lives for the Worker instance lifetime)
let cachedJwks = null;

async function getJwks() {
  if (cachedJwks) return cachedJwks;
  const res = await fetch(CLERK_JWKS_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
  cachedJwks = await res.json();
  return cachedJwks;
}

function b64url(str) {
  const s   = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - s.length % 4) % 4);
  return atob(s + pad);
}

async function verifyClerkToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [hdr, pay, sig] = parts;

    const header  = JSON.parse(b64url(hdr));
    const payload = JSON.parse(b64url(pay));

    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;

    const jwks = await getJwks();
    const jwk  = jwks.keys.find(k => k.kid === header.kid);
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    );

    const sigInput = new TextEncoder().encode(hdr + '.' + pay);
    const sigBytes = Uint8Array.from(b64url(sig), c => c.charCodeAt(0));
    const valid    = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigBytes, sigInput);

    return valid ? payload : null;
  } catch {
    return null;
  }
}

async function handleAdminProxy(request, url, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const payload = await verifyClerkToken(auth.slice(7));
  if (!payload || payload.sub !== ADMIN_USER_ID) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const pgPath = url.pathname.replace(/^\/api\/admin/, '');
  const pgUrl  = POSTGREST_BASE + pgPath + (url.search || '');

  const fwdHeaders = new Headers({
    'Authorization': `Bearer ${env.ADMIN_JWT}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  });
  const prefer = request.headers.get('Prefer');
  if (prefer) fwdHeaders.set('Prefer', prefer);

  const body = (request.method !== 'GET' && request.method !== 'HEAD')
    ? await request.arrayBuffer()
    : undefined;

  const pgRes = await fetch(pgUrl, { method: request.method, headers: fwdHeaders, body });

  return new Response(pgRes.body, {
    status: pgRes.status,
    headers: {
      'Content-Type': pgRes.headers.get('Content-Type') || 'application/json',
    },
  });
}

async function handlePublicProxy(url) {
  const pgPath = url.pathname.replace(/^\/api/, '');
  const pgUrl  = POSTGREST_BASE + pgPath + (url.search || '');

  const pgRes = await fetch(pgUrl, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });

  const body = await pgRes.text();
  return new Response(body, {
    status: pgRes.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

function injectAnalytics(response, env) {
  const ct = response.headers.get('content-type') || ''
  if (ct.includes('text/html') && env.UMAMI_SITE_ID) {
    return new HTMLRewriter()
      .on('head', {
        element(el) {
          el.append(`<script defer src="https://analytics.devlab502.net/script.js" data-website-id="${env.UMAMI_SITE_ID}"></script>`, { html: true })
        }
      })
      .transform(response)
  }
  return response
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Admin API: /api/admin/* — Clerk JWT required
    if (url.pathname.startsWith('/api/admin/')) {
      return handleAdminProxy(request, url, env);
    }

    // Public API: /api/* — GET only, anon
    if (url.pathname.startsWith('/api/')) {
      return handlePublicProxy(url);
    }

    // Static assets via Workers Sites (KV)
    try {
      const response = await getAssetFromKV(
        { request, waitUntil: ctx.waitUntil.bind(ctx) },
        { ASSET_NAMESPACE: env.__STATIC_CONTENT, ASSET_MANIFEST: assetManifest }
      );
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
      return injectAnalytics(new Response(response.body, { status: response.status, headers }), env);
    } catch {
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
        return injectAnalytics(new Response(fallback.body, { status: 200, headers }), env);
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    }
  },
};
