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

## Environment Variables
None required (all data is hardcoded)

## Database Needs
Current: none — all player data is hardcoded in JS arrays (PLAYERS, FIN_PLAYERS)

## Image Storage
Player images served from Cloudflare R2 via cdn.devlab502.net
- Bucket: `devlab502-uploads`
- Prefix: `arsenal-report/`
- 23 player PNG files
- Arsenal crest logo is base64-encoded inline in HTML

## Contact
devlab502@proton.me
