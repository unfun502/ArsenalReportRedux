/**
 * Excel import script — reads "Arsenal Salaries 2-17-26.xlsx" (multi-sheet)
 * Merges into Postgres via PostgREST:
 *   Sheet "Player Info":  fbref_id, fbref_url
 *   Sheet "Salary":       signed, expiration, salary_history per season
 *   Sheet "Transfer Fee": transfer_date, year_signed
 *
 * Run: npm run import-excel
 * Safe to re-run — uses PATCH for player fields, upsert for salary_history.
 */

import { config } from 'dotenv';
import { fileURLToPath as _ftu } from 'url';
import { dirname as _dn, resolve as _res } from 'path';
config({ path: _res(_dn(_ftu(import.meta.url)), '.env') });
import ExcelJS from 'exceljs';
import fetch from 'node-fetch';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const XLSX_PATH = resolve(__dirname, '..', 'Arsenal Salaries 2-17-26.xlsx');

const POSTGREST_URL = process.env.POSTGREST_URL;
const ADMIN_JWT     = process.env.ADMIN_JWT;

if (!POSTGREST_URL || !ADMIN_JWT) {
  console.error('Missing POSTGREST_URL or ADMIN_JWT in admin/.env');
  process.exit(1);
}

const headers = {
  'Authorization': `Bearer ${ADMIN_JWT}`,
  'Content-Type': 'application/json',
};

async function getPlayers() {
  const r = await fetch(`${POSTGREST_URL}/players`, { headers });
  return r.json();
}

async function patchPlayer(id, fields) {
  const r = await fetch(`${POSTGREST_URL}/players?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Prefer': 'return=representation' },
    body: JSON.stringify(fields),
  });
  if (!r.ok) throw new Error(`PATCH player ${id}: ${await r.text()}`);
}

async function upsertSalaryHistory(player_id, season, salary_py_raw) {
  const r = await fetch(`${POSTGREST_URL}/salary_history`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify({ player_id, season, salary_py_raw }),
  });
  if (!r.ok) throw new Error(`Upsert salary ${player_id} ${season}: ${await r.text()}`);
}

// Strip accents, lowercase, trim
function normalize(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// Build a lookup map of last-name → player (for abbreviated names like "G. Martinelli")
function buildLastNameMap(dbPlayers) {
  const map = new Map();
  for (const p of dbPlayers) {
    const parts = normalize(p.name).split(/\s+/);
    const lastName = parts[parts.length - 1];
    // Only add if unique (avoid collisions)
    if (!map.has(lastName)) map.set(lastName, p);
    else map.set(lastName, null); // collision — ambiguous
  }
  return map;
}

function findPlayer(excelName, byFullName, byFbrefId, byLastName, fbrefId) {
  if (fbrefId && byFbrefId.has(String(fbrefId).trim())) return byFbrefId.get(String(fbrefId).trim());
  const norm = normalize(excelName);
  if (byFullName.has(norm)) return byFullName.get(norm);
  // Try last-token match for abbreviated names (e.g. "G. Martinelli" → "martinelli")
  const lastToken = norm.split(/\s+/).pop();
  const byLast = byLastName.get(lastToken);
  if (byLast) return byLast; // null means ambiguous, undefined means not found
  return null;
}

function parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  const s = String(val).trim();
  if (!s || s === '—') return null;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function parseNumber(val) {
  if (val === null || val === undefined || val === '' || val === '—') return null;
  // ExcelJS formula cells: { formula, result }
  const raw = (val && typeof val === 'object' && 'result' in val) ? val.result : val;
  const n = parseInt(String(raw).replace(/[^0-9.-]/g, ''), 10);
  return isNaN(n) ? null : n;
}

// Build colName→colIndex map from a header row
function buildColMap(ws) {
  const colMap = {};
  ws.getRow(1).eachCell((cell, c) => {
    const key = String(cell.value || '').trim();
    if (key) colMap[key] = c;
  });
  return colMap;
}

// Get cell value by header name
function get(row, colMap, name) {
  const col = colMap[name];
  if (!col) return undefined;
  const val = row.getCell(col).value;
  // Unwrap hyperlink objects
  if (val && typeof val === 'object' && 'text' in val) return val.text;
  if (val && typeof val === 'object' && 'hyperlink' in val) return val.hyperlink;
  return val;
}

async function run() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX_PATH);

  // Load DB players and build lookup maps
  const dbPlayers = await getPlayers();
  const byFullName = new Map(dbPlayers.map(p => [normalize(p.name), p]));
  const byFbrefId  = new Map(dbPlayers.filter(p => p.fbref_id).map(p => [p.fbref_id, p]));
  const byLastName = buildLastNameMap(dbPlayers);

  let updated = 0, skipped = 0, salaryRows = 0;
  const patchPromises = [];

  // ── Sheet 1: Player Info ─────────────────────────────────────────────────
  const wsInfo = wb.getWorksheet('Player Info');
  if (wsInfo) {
    const colMap = buildColMap(wsInfo);
    console.log('\n=== Player Info sheet ===');
    wsInfo.eachRow((row, n) => {
      if (n === 1) return;
      const rawName = get(row, colMap, 'Player');
      if (!rawName) return;
      const fbrefId  = get(row, colMap, 'FBref ID');
      const fbrefUrl = get(row, colMap, 'FBref URL');

      const dbPlayer = findPlayer(rawName, byFullName, byFbrefId, byLastName, fbrefId);
      if (!dbPlayer) {
        console.warn(`  ⚠ No DB match: "${rawName}"`);
        skipped++;
        return;
      }

      const fields = {};
      if (fbrefId)  fields.fbref_id  = String(fbrefId).trim();
      if (fbrefUrl) fields.fbref_url = String(fbrefUrl).trim();

      if (Object.keys(fields).length > 0) {
        // Update local maps so later sheets can match by fbref_id
        if (fields.fbref_id) byFbrefId.set(fields.fbref_id, dbPlayer);
        patchPromises.push(
          patchPlayer(dbPlayer.id, fields)
            .then(() => { console.log(`  ✓ ${dbPlayer.name} — fbref_id, fbref_url`); updated++; })
            .catch(err => console.error(`  ✗ ${dbPlayer.name}:`, err.message))
        );
      }
    });
  }

  // ── Sheet 2: Salary ──────────────────────────────────────────────────────
  const wsSalary = wb.getWorksheet('Salary');
  if (wsSalary) {
    const colMap = buildColMap(wsSalary);
    console.log('\n=== Salary sheet ===');
    const seasonCols = [
      { header: 'Total Gross P/Y (21/22)', season: '21/22' },
      { header: 'Total Gross P/Y (22/23)', season: '22/23' },
      { header: 'Total Gross P/Y (23/24)', season: '23/24' },
      { header: 'Total Gross P/Y (24/25)', season: '24/25' },
      { header: 'Total Gross P/Y (25/26)', season: '25/26' },
    ];

    wsSalary.eachRow((row, n) => {
      if (n === 1) return;
      const fbrefId = get(row, colMap, 'FBref ID');
      const rawName = get(row, colMap, 'Player');
      if (!rawName && !fbrefId) return;

      const dbPlayer = findPlayer(rawName || '', byFullName, byFbrefId, byLastName, fbrefId);
      if (!dbPlayer) {
        console.warn(`  ⚠ No DB match: "${rawName}" (${fbrefId})`);
        skipped++;
        return;
      }

      const signed     = parseDate(get(row, colMap, 'Signed'));
      const expiration = parseDate(get(row, colMap, 'Expiration'));
      const fields = {};
      if (signed)     fields.signed     = signed;
      if (expiration) fields.expiration = expiration;

      if (Object.keys(fields).length > 0) {
        patchPromises.push(
          patchPlayer(dbPlayer.id, fields)
            .then(() => { console.log(`  ✓ ${dbPlayer.name} — signed, expiration`); updated++; })
            .catch(err => console.error(`  ✗ ${dbPlayer.name}:`, err.message))
        );
      }

      // Salary history per season
      for (const { header, season } of seasonCols) {
        const rawSalary = get(row, colMap, header);
        const salary = parseNumber(rawSalary);
        if (salary && salary > 0) {
          patchPromises.push(
            upsertSalaryHistory(dbPlayer.id, season, salary)
              .then(() => { console.log(`  ✓ ${dbPlayer.name} ${season} → ${salary}`); salaryRows++; })
              .catch(err => console.error(`  ✗ salary ${dbPlayer.name} ${season}:`, err.message))
          );
        }
      }
    });
  }

  // ── Sheet 3: Transfer Fee ────────────────────────────────────────────────
  const wsXfer = wb.getWorksheet('Transfer Fee');
  if (wsXfer) {
    const colMap = buildColMap(wsXfer);
    console.log('\n=== Transfer Fee sheet ===');
    wsXfer.eachRow((row, n) => {
      if (n === 1) return;
      const fbrefId = get(row, colMap, 'FBref ID');
      const rawName = get(row, colMap, 'Player');
      if (!rawName && !fbrefId) return;

      const dbPlayer = findPlayer(rawName || '', byFullName, byFbrefId, byLastName, fbrefId);
      if (!dbPlayer) {
        console.warn(`  ⚠ No DB match: "${rawName}" (${fbrefId})`);
        skipped++;
        return;
      }

      const xferDate  = get(row, colMap, 'Transfer Date');
      const yearSigned = get(row, colMap, 'Year signed (End of Year)');
      const fields = {};
      if (xferDate)   fields.transfer_date = parseDate(xferDate);
      if (yearSigned !== undefined && yearSigned !== null)
                      fields.year_signed   = parseNumber(yearSigned);

      if (Object.keys(fields).length > 0) {
        patchPromises.push(
          patchPlayer(dbPlayer.id, fields)
            .then(() => { console.log(`  ✓ ${dbPlayer.name} — transfer_date, year_signed`); updated++; })
            .catch(err => console.error(`  ✗ ${dbPlayer.name}:`, err.message))
        );
      }
    });
  }

  // Wait for all async operations
  await Promise.allSettled(patchPromises);

  console.log(`\nImport complete:`);
  console.log(`  Players updated:      ${updated}`);
  console.log(`  Players not matched:  ${skipped}`);
  console.log(`  Salary rows upserted: ${salaryRows}`);
}

run().catch(err => { console.error(err); process.exit(1); });
