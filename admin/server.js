/**
 * Arsenal Report Admin Server
 * Runs locally at http://localhost:3001 — no auth needed (localhost only)
 * Proxies write requests to PostgREST at api.devlab502.net/arsenal with admin JWT
 */

import { config } from 'dotenv';
import { fileURLToPath as _ftu } from 'url';
import { dirname as _dn, resolve as _res } from 'path';
config({ path: _res(_dn(_ftu(import.meta.url)), '.env') });
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { createServer } from 'http';
import open from 'open';
import multer from 'multer';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const __dirname = dirname(fileURLToPath(import.meta.url));

const POSTGREST_URL      = process.env.POSTGREST_URL;
const ADMIN_JWT          = process.env.ADMIN_JWT;
const PORT               = parseInt(process.env.PORT || '3001', 10);
const R2_ACCOUNT_ID      = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID   = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET          = 'devlab502-uploads';
const CDN_BASE           = 'https://cdn.devlab502.net/arsenal-report';

if (!POSTGREST_URL || !ADMIN_JWT) {
  console.error('\nERROR: Missing required env vars. Ensure admin/.env exists with:');
  console.error('  POSTGREST_URL=https://api.devlab502.net/arsenal');
  console.error('  ADMIN_JWT=<your admin JWT>\n');
  process.exit(1);
}

// R2 client (optional — only needed for image uploads)
const r2 = (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY)
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    })
  : null;

if (!r2) {
  console.warn('⚠  R2 credentials not set — image upload will be unavailable.');
  console.warn('   Add R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY to admin/.env\n');
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ── Helpers ────────────────────────────────────────────────────────────────

function adminHeaders(extra = {}) {
  return {
    'Authorization': `Bearer ${ADMIN_JWT}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
    ...extra,
  };
}

async function pgrest(method, path, body) {
  const { default: fetch } = await import('node-fetch');
  const url = `${POSTGREST_URL}${path}`;
  const opts = { method, headers: adminHeaders() };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data };
}

// ── Players ────────────────────────────────────────────────────────────────

// GET /api/players — all players (including inactive)
app.get('/api/players', async (req, res) => {
  const { status, data } = await pgrest('GET', '/players?order=squad_num.asc.nullslast');
  res.status(status).json(data);
});

// GET /api/players/:id
app.get('/api/players/:id', async (req, res) => {
  const { status, data } = await pgrest('GET', `/players?id=eq.${req.params.id}`);
  res.status(status).json(Array.isArray(data) ? data[0] : data);
});

// POST /api/players — create player
app.post('/api/players', async (req, res) => {
  const { status, data } = await pgrest('POST', '/players', req.body);
  res.status(status).json(data);
});

// PATCH /api/players/:id — update player
app.patch('/api/players/:id', async (req, res) => {
  const { status, data } = await pgrest('PATCH', `/players?id=eq.${req.params.id}`, req.body);
  res.status(status).json(data);
});

// DELETE /api/players/:id — soft delete (set active=false)
app.delete('/api/players/:id', async (req, res) => {
  const { status, data } = await pgrest('PATCH', `/players?id=eq.${req.params.id}`, { active: false });
  res.status(status).json(data);
});

// ── Salary History ─────────────────────────────────────────────────────────

// GET /api/players/:id/salary-history
app.get('/api/players/:id/salary-history', async (req, res) => {
  const { status, data } = await pgrest('GET', `/salary_history?player_id=eq.${req.params.id}&order=season.asc`);
  res.status(status).json(data);
});

// PUT /api/players/:id/salary-history/:season — upsert a season
app.put('/api/players/:id/salary-history/:season', async (req, res) => {
  const { default: fetch } = await import('node-fetch');
  const url = `${POSTGREST_URL}/salary_history`;
  const body = {
    player_id: parseInt(req.params.id),
    season: decodeURIComponent(req.params.season),
    salary_py_raw: req.body.salary_py_raw,
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      ...adminHeaders(),
      'Prefer': 'return=representation,resolution=merge-duplicates',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  res.status(r.status).json(text ? JSON.parse(text) : null);
});

// DELETE /api/players/:id/salary-history/:season
app.delete('/api/players/:id/salary-history/:season', async (req, res) => {
  const season = decodeURIComponent(req.params.season);
  const { status, data } = await pgrest(
    'DELETE',
    `/salary_history?player_id=eq.${req.params.id}&season=eq.${encodeURIComponent(season)}`
  );
  res.status(status).json(data);
});

// ── Formation Slots ─────────────────────────────────────────────────────────

// GET /api/formation — all slots ordered by row then slot
app.get('/api/formation', async (req, res) => {
  const { status, data } = await pgrest('GET', '/formation_slots?order=row_order.asc,slot_order.asc');
  res.status(status).json(data);
});

// PUT /api/formation/:id — update a slot (player_names array)
app.put('/api/formation/:id', async (req, res) => {
  const { status, data } = await pgrest('PATCH', `/formation_slots?id=eq.${req.params.id}`, req.body);
  res.status(status).json(data);
});

// ── Amortization Schedule (read-only proxy) ────────────────────────────────

app.get('/api/amortization', async (req, res) => {
  const { status, data } = await pgrest('GET', '/amortization_schedule?order=player_name.asc,season_offset.asc');
  res.status(status).json(data);
});

// ── Image Upload to R2 ───────────────────────────────────────────────────────

// Derive a URL-safe slug from a player name (e.g. "Gabriel Martinelli" → "gabriel-martinelli")
function nameToSlug(name) {
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

app.post('/api/upload-image', upload.single('image'), async (req, res) => {
  if (!r2) {
    return res.status(503).json({
      error: 'R2 not configured. Add R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY to admin/.env',
    });
  }
  const { playerName } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No image file provided' });
  if (!playerName) return res.status(400).json({ error: 'playerName is required' });

  const slug = nameToSlug(playerName);
  const ext  = extname(req.file.originalname).toLowerCase() || '.png';
  const key  = `arsenal-report/${slug}${ext}`;

  await r2.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: req.file.buffer,
    ContentType: req.file.mimetype || 'image/png',
  }));

  const url = `${CDN_BASE}/${slug}${ext}`;
  res.json({ url, key });
});

// ── Dev health check ────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true, postgrest: POSTGREST_URL, r2: !!r2 }));

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nArsenal Report Admin running at ${url}\n`);
  // Open browser automatically
  open(url).catch(() => {});
});
