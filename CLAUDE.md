# CLAUDE.md — ArsenalReportRedux

## What This App Does
Interactive Arsenal FC squad report for the 2025–26 season. Features four pages:
1. **Squad** — Filterable/sortable player card grid with detail modals
2. **Financials** — Sortable data table + D3.js visualizations (treemap, scatter plot, contract timeline)
3. **Depth Chart** — Formation-style depth chart showing starters and backups
4. **Notes** — Textual analysis and external links

## Tech Stack
Plain HTML/CSS/JS (single-file app), no build step, Cloudflare Workers
- External: Google Fonts (Bebas Neue, Barlow), D3.js v7.8.5 (lazy-loaded from CDN)

## Domain
arsenal-report.devlab502.net (custom domain on Workers)

## Build & Deploy
- No build step — static HTML served by Worker via `@cloudflare/kv-asset-handler`
- Deploys via GitHub Actions → `wrangler deploy` on push to main
- Worker entry point: `worker.js`
- Static files served from `public/` directory

## Architecture

```
Public browser
  → Cloudflare Worker (arsenalreportredux)
      ├── Static assets: GET /  → serves public/index.html
      └── API proxy:    GET /api/* → forwards to api.devlab502.net/arsenal/*

VPS (107.172.92.103)
  └── Docker Compose (~/feedback/)
      ├── Postgres 16 → database: arsenal_report, schema: arsenal_report
      ├── arsenal-api (PostgREST v12.2.3, port 3004)
      └── Caddy → /arsenal/* → arsenal-api:3004

Local Admin (this laptop only)
  └── admin/server.js (Express, localhost:3001)
      → Reads/writes via api.devlab502.net/arsenal/* with admin JWT
      → Run: npm run admin
```

## Database
- Postgres 16 on VPS, database `arsenal_report`, schema `arsenal_report`
- PostgREST at `https://api.devlab502.net/arsenal`
- Roles: `arsenal_admin` (full write), `anon` (read-only on the public read model only)
- Tables: `players`, `salary_history`, `formation_slots`, `app_settings`
- Views: `squad` (public read model), `amortization_schedule`
- Fresh install: `scripts/schema.sql`. Existing DB changes: `scripts/migrations/`

### squad view (what the public app reads via `/api/squad`)
Active players joined with their current-season salary. Computed columns:
- `salary_py_raw` — from `salary_history` at `app_settings.current_season`
- `salary_pw_raw` — `round(salary_py_raw / 52)`
- `contract_yrs` — expiration year minus current season start year
- `year_signed` — derived from `transfer_date` (end-of-year convention: Jul–Dec → year+1);
  falls back to the stored `players.year_signed` (Academy joined-year)
- `amort_raw` — this season's amortization charge: `transfer_fee_raw × 1m / amort_years`
  while within the amortization window, else 0

### players table key fields
- `transfer_fee_raw` — fee in millions (e.g. 75.0 = €75m)
- `transfer_type` — 'Transfer', 'Academy', 'Loan', 'Free'
- `transfer_date` / `signed` / `expiration` — DATE columns
- `year_signed` — Academy players only (year joined); derived for transfers
- `amort_years` — initial contract length for amortization (default 5 = UEFA cap;
  override in admin when the reported initial deal was shorter)
- `active` — false for departed/sold players (squad view filters these out)
- Current salary is NOT stored on players — it's the `salary_history` row for
  `app_settings.current_season`

### anon (public) can read only
`squad`, `formation_slots` (`player_ids` arrays reference `players.id`),
`app_settings`, `amortization_schedule` — not `players` or `salary_history`

## Admin Authentication

This app uses **Clerk** for admin authentication (exception to the standard `VITE_ADMIN_JWT` pattern — plain HTML, no Vite build step). See `DEVLAB502-AUDIT-PROMPT-v2.md` for the full explanation.

- Public admin UI lives at `/admin.html`
- Admin user ID hardcoded in both `worker.js` (`ADMIN_USER_ID`) and `public/admin.html`
- Clerk publishable key: `pk_test_bGVhcm5pbmctZ3JvdXBlci0yNS5jbGVyay5hY2NvdW50cy5kZXYk` (dev mode — safe to commit)
- JWKS URL: `https://learning-grouper-25.clerk.accounts.dev/.well-known/jwks.json`
- Worker verifies Clerk JWT for all `/api/admin/*` requests, then forwards to PostgREST using `env.ADMIN_JWT` (Worker secret)
- Admin nav link in `index.html` visible only to the configured admin user ID

## Local Admin Server
- Run: `npm run admin` → starts Express at localhost:3001, opens browser
- Requires: `admin/.env` with `POSTGREST_URL` and `ADMIN_JWT`
- Template: `admin/.env.example` (never commit `admin/.env`)
- Generate JWT: `python scripts/generate-admin-jwt.py`
- Pages: Players list, Add/Edit player (all fields + salary history), Formation editor

## One-time Scripts
- `npm run seed` — seeds players + formation slots from hardcoded data (run once on fresh DB)
- `npm run import-excel` — imports Excel fields into DB (fbref, dates, salary history)

## Environment Variables
### Worker secrets (set via `wrangler secret put`)
- `ADMIN_JWT` — PostgREST `arsenal_admin` JWT; injected into `/api/admin/*` proxy requests

### Admin server (admin/.env — gitignored)
- `POSTGREST_URL=https://api.devlab502.net/arsenal`
- `ADMIN_JWT=<arsenal_admin JWT>`
- `PORT=3001`

## Image Storage
Player images served from Cloudflare R2 via cdn.devlab502.net
- Bucket: `devlab502-uploads`
- Prefix: `arsenal-report/`
- Arsenal crest logo is base64-encoded inline in HTML
- Set `img_url` field in admin when uploading new player images

## Seasonal Updates
To roll over to a new season:
1. Insert a new `salary_history` row per player for the new season via the admin's player edit page
2. Update `app_settings.current_season` (e.g. `'26/27'`) — the squad view, salary display,
   contract years, and amortization all follow automatically

## Contact
devlab502@proton.me
