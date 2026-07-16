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
import { runSquadSync } from '../squad-sync.js';

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

// GET /api/players — all players (including inactive), with salary history embedded
app.get('/api/players', async (req, res) => {
  const { status, data } = await pgrest('GET', '/players?select=*,salary_history(season,salary_py_raw)&order=squad_num.asc.nullslast');
  res.status(status).json(data);
});

// GET /api/settings — app settings (current_season etc.)
app.get('/api/settings', async (req, res) => {
  const { status, data } = await pgrest('GET', '/app_settings');
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

// PUT /api/formation/:id — update a slot (player_ids array)
app.put('/api/formation/:id', async (req, res) => {
  const { status, data } = await pgrest('PATCH', `/formation_slots?id=eq.${req.params.id}`, req.body);
  res.status(status).json(data);
});

// ── Pending Updates (squad sync review queue) ──────────────────────────────

// football-data.org position → pos_group
function mapPosGroup(fdPos) {
  const s = String(fdPos || '').toLowerCase();
  if (s.includes('keeper')) return 'Goalkeeper';
  if (s.includes('defen') || s.includes('back')) return 'Defender';
  if (s.includes('midfield')) return 'Midfielder';
  if (s.includes('forward') || s.includes('wing') || s.includes('attack') || s.includes('offence')) return 'Forward';
  return 'Midfielder';
}

// GET /api/updates — pending review items
app.get('/api/updates', async (req, res) => {
  const { status, data } = await pgrest('GET', '/pending_updates?status=eq.pending&order=created_at.desc');
  res.status(status).json(data);
});

// POST /api/updates/sync — run the squad sync on demand
app.post('/api/updates/sync', async (req, res) => {
  try {
    const summary = await runSquadSync({
      fdToken: process.env.FOOTBALL_DATA_TOKEN,
      postgrestUrl: POSTGREST_URL,
      adminJwt: ADMIN_JWT,
    });
    res.json(summary);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/updates/:id/approve — apply the change, mark approved
app.post('/api/updates/:id/approve', async (req, res) => {
  const { data: rows } = await pgrest('GET', `/pending_updates?id=eq.${req.params.id}&status=eq.pending`);
  const upd = Array.isArray(rows) ? rows[0] : null;
  if (!upd) return res.status(404).json({ error: 'Pending update not found' });

  let applied;
  if (upd.kind === 'possible_departure') {
    applied = await pgrest('PATCH', `/players?id=eq.${upd.player_id}`, { active: false });
  } else if (upd.kind === 'squad_num_change') {
    applied = await pgrest('PATCH', `/players?id=eq.${upd.player_id}`, { squad_num: parseInt(upd.new_value, 10) });
  } else if (upd.kind === 'new_player') {
    const p = upd.payload || {};
    applied = await pgrest('POST', '/players', {
      name: upd.subject,
      pos: p.position || 'TBD',
      pos_group: mapPosGroup(p.position),
      dob: p.dateOfBirth || null,
      nationality: p.nationality || 'TBD',
      squad_num: p.shirtNumber ?? null,
      transfer_type: 'Transfer',
      active: true,
    });
  } else {
    return res.status(400).json({ error: `Unknown kind: ${upd.kind}` });
  }
  if (applied.status >= 300) return res.status(applied.status).json(applied.data);

  const { status, data } = await pgrest('PATCH', `/pending_updates?id=eq.${upd.id}`,
    { status: 'approved', resolved_at: new Date().toISOString() });
  // For new players, hand back the created row so the UI can open the edit page
  const created = upd.kind === 'new_player' && Array.isArray(applied.data) ? applied.data[0] : null;
  res.status(status).json({ update: Array.isArray(data) ? data[0] : data, created_player: created });
});

// POST /api/updates/:id/dismiss — reject; never shown again (dedupe key stays)
app.post('/api/updates/:id/dismiss', async (req, res) => {
  const { status, data } = await pgrest('PATCH', `/pending_updates?id=eq.${req.params.id}&status=eq.pending`,
    { status: 'dismissed', resolved_at: new Date().toISOString() });
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
