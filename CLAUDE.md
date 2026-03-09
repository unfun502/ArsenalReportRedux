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
- Roles: `arsenal_admin` (full write), `anon` (read-only, active players only)
- Tables: `players`, `salary_history`, `formation_slots`
- View: `amortization_schedule` (computed from `transfer_fee_raw / 5` × 5 active + 5 zero seasons)

### players table key fields
- `salary_pw_raw` / `salary_py_raw` — raw integers in euros (format client-side)
- `transfer_fee_raw` — fee in millions (e.g. 75.0 = €75m)
- `transfer_type` — 'Transfer', 'Academy', 'Loan', 'Free'
- `transfer_date` / `signed` / `expiration` — ISO date strings
- `year_signed` — end-of-year convention (e.g. 2024 for Jul 2023 signing)
- `active` — false for departed/sold players (anon role filters these out)

## Admin Server
- Run: `npm run admin` → starts Express at localhost:3001, opens browser
- Requires: `admin/.env` with `POSTGREST_URL` and `ADMIN_JWT`
- Template: `admin/.env.example` (never commit `admin/.env`)
- Generate JWT: `python scripts/generate-admin-jwt.py`
- Pages: Players list, Add/Edit player (all fields + salary history), Formation editor

## One-time Scripts
- `npm run seed` — seeds players + formation slots from hardcoded data (run once on fresh DB)
- `npm run import-excel` — imports Excel fields into DB (fbref, dates, salary history)

## Environment Variables
### Worker (no variables needed)
Static site; all data fetched from public PostgREST endpoint via Worker proxy.

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
To add a new season's salary data for all players:
1. Update each player's `salary_pw_raw` and `salary_py_raw` in the admin
2. Insert a new `salary_history` row per player for the new season via the admin's player edit page

## Contact
devlab502@proton.me
