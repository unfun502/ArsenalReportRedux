/**
 * Seed script — imports hardcoded player + formation data into Postgres via PostgREST
 * Run once: npm run seed
 */

import { config } from 'dotenv';
import { fileURLToPath as _ftu } from 'url';
import { dirname as _dn, resolve as _res } from 'path';
config({ path: _res(_dn(_ftu(import.meta.url)), '.env') });
import fetch from 'node-fetch';

const POSTGREST_URL = process.env.POSTGREST_URL;
const ADMIN_JWT     = process.env.ADMIN_JWT;

if (!POSTGREST_URL || !ADMIN_JWT) {
  console.error('Missing POSTGREST_URL or ADMIN_JWT in admin/.env');
  process.exit(1);
}

const headers = {
  'Authorization': `Bearer ${ADMIN_JWT}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation',
};

async function post(path, body) {
  const r = await fetch(`${POSTGREST_URL}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`POST ${path} → ${r.status}: ${err}`);
  }
  return r.json();
}

// ── Player Data ─────────────────────────────────────────────────────────────
// Converted from hardcoded PLAYERS + FIN_PLAYERS arrays in public/index.html
// transfer_type and transfer_fee_raw derived from the fee string
// salary_pw_raw and salary_py_raw from FIN_PLAYERS salaryPWRaw / salaryPYRaw
// img_url derived from R2 CDN pattern (cdn.devlab502.net/arsenal-report/<slug>.png)

const CDN = 'https://cdn.devlab502.net/arsenal-report';

const players = [
  { squad_num: 29, name: 'Kai Havertz',        pos: 'CF / CAM',     pos_group: 'Forward',    dob: '1999-06-11', nationality: 'Germany',     transfer_type: 'Transfer', transfer_fee_raw: 75.0,  year_signed: 2023, salary_pw_raw: 324372,  salary_py_raw: 16867343, contract_yrs: 3, img_url: `${CDN}/kai-havertz.png` },
  { squad_num: 9,  name: 'Gabriel Jesus',       pos: 'CF',           pos_group: 'Forward',    dob: '1997-04-03', nationality: 'Brazil',      transfer_type: 'Transfer', transfer_fee_raw: 52.2,  year_signed: 2022, salary_pw_raw: 306995,  salary_py_raw: 15963736, contract_yrs: 2, img_url: `${CDN}/gabriel-jesus.png` },
  { squad_num: 2,  name: 'William Saliba',      pos: 'CB',           pos_group: 'Defender',   dob: '2001-03-24', nationality: 'France',      transfer_type: 'Transfer', transfer_fee_raw: 30.0,  year_signed: 2019, salary_pw_raw: 289618,  salary_py_raw: 15060128, contract_yrs: 5, img_url: `${CDN}/william-saliba.png` },
  { squad_num: 8,  name: 'Martin Ødegaard',     pos: 'CAM',          pos_group: 'Midfielder', dob: '1998-12-17', nationality: 'Norway',      transfer_type: 'Transfer', transfer_fee_raw: 35.0,  year_signed: 2021, salary_pw_raw: 278033,  salary_py_raw: 14457723, contract_yrs: 3, img_url: `${CDN}/martin-odegaard.png` },
  { squad_num: 41, name: 'Declan Rice',         pos: 'DM / CM',      pos_group: 'Midfielder', dob: '1999-01-14', nationality: 'England',     transfer_type: 'Transfer', transfer_fee_raw: 116.6, year_signed: 2023, salary_pw_raw: 278033,  salary_py_raw: 14457723, contract_yrs: 3, img_url: `${CDN}/declan-rice.png` },
  { squad_num: 14, name: 'Viktor Gyökeres',     pos: 'CF',           pos_group: 'Forward',    dob: '1998-06-04', nationality: 'Sweden',      transfer_type: 'Transfer', transfer_fee_raw: 66.9,  year_signed: 2025, salary_pw_raw: 231694,  salary_py_raw: 12048102, contract_yrs: 5, img_url: `${CDN}/viktor-gyokeres.png` },
  { squad_num: 7,  name: 'Bukayo Saka',         pos: 'RW',           pos_group: 'Forward',    dob: '2001-09-05', nationality: 'England',     transfer_type: 'Academy',  transfer_fee_raw: null,  year_signed: null, salary_pw_raw: 225902,  salary_py_raw: 11746900, contract_yrs: 2, img_url: `${CDN}/bukayo-saka.png` },
  { squad_num: 10, name: 'Eberechi Eze',        pos: 'CAM / RW',     pos_group: 'Midfielder', dob: '1998-06-29', nationality: 'England',     transfer_type: 'Transfer', transfer_fee_raw: 69.3,  year_signed: 2025, salary_pw_raw: 208525,  salary_py_raw: 10843292, contract_yrs: 4, img_url: `${CDN}/eberechi-eze.png` },
  { squad_num: 11, name: 'Gabriel Martinelli',  pos: 'LW',           pos_group: 'Forward',    dob: '2001-06-18', nationality: 'Brazil',      transfer_type: 'Transfer', transfer_fee_raw: 7.1,   year_signed: 2019, salary_pw_raw: 208525,  salary_py_raw: 10843292, contract_yrs: 2, img_url: `${CDN}/gabriel-martinelli.png` },
  { squad_num: 19, name: 'Leandro Trossard',    pos: 'LW / RW',      pos_group: 'Forward',    dob: '1994-12-04', nationality: 'Belgium',     transfer_type: 'Transfer', transfer_fee_raw: 24.0,  year_signed: 2023, salary_pw_raw: 208525,  salary_py_raw: 10843292, contract_yrs: 2, img_url: `${CDN}/leandro-trossard.png` },
  { squad_num: 4,  name: 'Ben White',           pos: 'RB',           pos_group: 'Defender',   dob: '1997-10-08', nationality: 'England',     transfer_type: 'Transfer', transfer_fee_raw: 58.5,  year_signed: 2021, salary_pw_raw: 173771,  salary_py_raw:  9036077, contract_yrs: 3, img_url: `${CDN}/ben-white.png` },
  { squad_num: 6,  name: 'Gabriel Magalhães',   pos: 'CB',           pos_group: 'Defender',   dob: '1997-12-19', nationality: 'Brazil',      transfer_type: 'Transfer', transfer_fee_raw: 26.0,  year_signed: 2020, salary_pw_raw: 173771,  salary_py_raw:  9036077, contract_yrs: 4, img_url: `${CDN}/gabriel-magalhaes.png` },
  { squad_num: 20, name: 'Noni Madueke',        pos: 'RW',           pos_group: 'Forward',    dob: '2002-03-10', nationality: 'England',     transfer_type: 'Transfer', transfer_fee_raw: 56.0,  year_signed: 2025, salary_pw_raw: 173771,  salary_py_raw:  9036077, contract_yrs: 5, img_url: `${CDN}/noni-madueke.png` },
  { squad_num: 23, name: 'Mikel Merino',        pos: 'CM',           pos_group: 'Midfielder', dob: '1996-06-22', nationality: 'Spain',       transfer_type: 'Transfer', transfer_fee_raw: 32.0,  year_signed: 2024, salary_pw_raw: 150601,  salary_py_raw:  7831267, contract_yrs: 3, img_url: `${CDN}/mikel-merino.png` },
  { squad_num: 33, name: 'Riccardo Calafiori',  pos: 'LB / CB',      pos_group: 'Defender',   dob: '2002-05-19', nationality: 'Italy',       transfer_type: 'Transfer', transfer_fee_raw: 45.0,  year_signed: 2024, salary_pw_raw: 139017,  salary_py_raw:  7228861, contract_yrs: 4, img_url: `${CDN}/riccardo-calafiori.png` },
  { squad_num: 1,  name: 'David Raya',          pos: 'GK',           pos_group: 'Goalkeeper', dob: '1995-09-15', nationality: 'Spain',       transfer_type: 'Transfer', transfer_fee_raw: 31.9,  year_signed: 2024, salary_pw_raw: 115847,  salary_py_raw:  6024051, contract_yrs: 3, img_url: `${CDN}/david-raya.png` },
  { squad_num: 12, name: 'Jurriën Timber',      pos: 'RB / CB',      pos_group: 'Defender',   dob: '2001-06-17', nationality: 'Netherlands', transfer_type: 'Transfer', transfer_fee_raw: 40.0,  year_signed: 2023, salary_pw_raw: 104262,  salary_py_raw:  5421646, contract_yrs: 3, img_url: `${CDN}/jurrijen-timber.png` },
  { squad_num: 36, name: 'Martín Zubimendi',    pos: 'DM',           pos_group: 'Midfielder', dob: '1999-02-02', nationality: 'Spain',       transfer_type: 'Transfer', transfer_fee_raw: 70.0,  year_signed: 2025, salary_pw_raw:  86885,  salary_py_raw:  4518038, contract_yrs: 5, img_url: `${CDN}/martin-zubimendi.png` },
  { squad_num: 16, name: 'Christian Nørgaard',  pos: 'CM / DM',      pos_group: 'Midfielder', dob: '1994-03-10', nationality: 'Denmark',     transfer_type: 'Transfer', transfer_fee_raw: 11.6,  year_signed: 2025, salary_pw_raw:  75301,  salary_py_raw:  3915633, contract_yrs: 2, img_url: `${CDN}/christian-norgaard.png` },
  { squad_num: 5,  name: 'Piero Hincapié',      pos: 'LB',           pos_group: 'Defender',   dob: '2002-01-09', nationality: 'Ecuador',     transfer_type: 'Loan',     transfer_fee_raw: null,  year_signed: 2025, salary_pw_raw:  75301,  salary_py_raw:  3915633, contract_yrs: 1, img_url: `${CDN}/piero-hincapie.png` },
  { squad_num: 13, name: 'Kepa Arrizabalaga',   pos: 'GK',           pos_group: 'Goalkeeper', dob: '1994-10-03', nationality: 'Spain',       transfer_type: 'Transfer', transfer_fee_raw: 5.8,   year_signed: 2024, salary_pw_raw:  69508,  salary_py_raw:  3614431, contract_yrs: 3, img_url: `${CDN}/kepa-arrizabalaga.png` },
  { squad_num: 3,  name: 'Cristhian Mosquera',  pos: 'CB',           pos_group: 'Defender',   dob: '2003-04-19', nationality: 'Spain',       transfer_type: 'Transfer', transfer_fee_raw: 15.0,  year_signed: 2025, salary_pw_raw:  63716,  salary_py_raw:  3313228, contract_yrs: 5, img_url: `${CDN}/cristhian-mosquera.png` },
  { squad_num: 49, name: 'Myles Lewis-Skelly',  pos: 'LB',           pos_group: 'Defender',   dob: '2006-09-24', nationality: 'England',     transfer_type: 'Academy',  transfer_fee_raw: null,  year_signed: null, salary_pw_raw:  52131,  salary_py_raw:  2710823, contract_yrs: 5, img_url: `${CDN}/myles-lewis-skelly.png` },
  { squad_num: null, name: 'Ethan Nwaneri',     pos: 'CAM / RW',     pos_group: 'Midfielder', dob: '2007-03-21', nationality: 'England',     transfer_type: 'Academy',  transfer_fee_raw: null,  year_signed: null, salary_pw_raw:  46339,  salary_py_raw:  2409620, contract_yrs: 5, img_url: `${CDN}/ethan-nwaneri.png` },
  { squad_num: 56, name: 'Max Dowman',          pos: 'RW / CAM',     pos_group: 'Forward',    dob: '2009-12-31', nationality: 'England',     transfer_type: 'Academy',  transfer_fee_raw: null,  year_signed: null, salary_pw_raw:  40547,  salary_py_raw:  2108418, contract_yrs: 1, img_url: null },
];

// ── Formation Data ──────────────────────────────────────────────────────────

const formation = [
  { row_name: 'Attack',     row_order: 1, pos: 'LW',  slot_order: 1, player_names: ['Martinelli', 'Trossard', 'Eze'] },
  { row_name: 'Attack',     row_order: 1, pos: 'CF',  slot_order: 2, player_names: ['Gyökeres', 'Havertz', 'Jesus'] },
  { row_name: 'Attack',     row_order: 1, pos: 'RW',  slot_order: 3, player_names: ['Saka', 'Madueke', 'Dowman'] },
  { row_name: 'Midfield',   row_order: 2, pos: 'LCM', slot_order: 1, player_names: ['Rice', 'Merino'] },
  { row_name: 'Midfield',   row_order: 2, pos: 'DCM', slot_order: 2, player_names: ['Zubimendi', 'Nørgaard'] },
  { row_name: 'Midfield',   row_order: 2, pos: 'RCM', slot_order: 3, player_names: ['Ødegaard', 'Eze'] },
  { row_name: 'Defence',    row_order: 3, pos: 'LB',  slot_order: 1, player_names: ['Hincapié', 'Calafiori', 'Lewis-Skelly'] },
  { row_name: 'Defence',    row_order: 3, pos: 'LCB', slot_order: 2, player_names: ['Magalhães', 'Hincapié'] },
  { row_name: 'Defence',    row_order: 3, pos: 'RCB', slot_order: 3, player_names: ['Saliba', 'Mosquera'] },
  { row_name: 'Defence',    row_order: 3, pos: 'RB',  slot_order: 4, player_names: ['Timber', 'White', 'Mosquera'] },
  { row_name: 'Goalkeeper', row_order: 4, pos: 'GK',  slot_order: 1, player_names: ['Raya', 'Arrizabalaga'] },
];

// ── Seed ────────────────────────────────────────────────────────────────────

async function seed() {
  // Normalize: ensure all player objects share the same keys (PostgREST requirement)
  const allKeys = [...new Set(players.flatMap(p => Object.keys(p)))];
  const normalized = players.map(p => {
    const obj = {};
    allKeys.forEach(k => { obj[k] = k in p ? p[k] : null; });
    return obj;
  });
  console.log(`Seeding ${normalized.length} players...`);
  const inserted = await post('/players', normalized);
  console.log(`  ✓ ${inserted.length} players inserted`);

  console.log(`Seeding ${formation.length} formation slots...`);
  await post('/formation_slots', formation);
  console.log(`  ✓ Formation seeded`);

  console.log('\nDone! Run npm run import-excel next to add transfer dates and salary history.');
}

seed().catch(err => { console.error(err); process.exit(1); });
