/**
 * Squad sync — diffs the current Arsenal squad on football-data.org (team 57)
 * against the players table and writes findings to pending_updates.
 *
 * Nothing touches the players table automatically: every finding is a
 * pending_updates row that the admin approves or dismisses. Dismissed
 * findings never come back (UNIQUE kind+subject+new_value).
 *
 * Used by:
 *   - worker.js scheduled handler (daily cron, 06:00 UTC)
 *   - admin/server.js "Run sync now" endpoint
 */

const FOOTBALL_DATA_URL = 'https://api.football-data.org/v4/teams/57';

// Strip accents, lowercase, trim — same normalization as import-excel.js
export function normName(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function lastToken(s) {
  return normName(s).split(/\s+/).pop();
}

/**
 * Pure diff: football-data squad entries vs DB player rows.
 * @param {Array<{id, name, position?, dateOfBirth?, nationality?, shirtNumber?}>} apiSquad
 * @param {Array<{id, name, squad_num, active}>} dbPlayers
 * @returns {Array<{kind, player_id, subject, old_value, new_value, payload}>}
 */
export function diffSquad(apiSquad, dbPlayers) {
  const active = dbPlayers.filter(p => p.active);

  const byFullName = new Map(active.map(p => [normName(p.name), p]));
  const byLastName = new Map();
  for (const p of active) {
    const key = lastToken(p.name);
    byLastName.set(key, byLastName.has(key) ? null : p); // null = ambiguous
  }

  const updates = [];
  const matchedDbIds = new Set();

  for (const ap of apiSquad) {
    const db = byFullName.get(normName(ap.name)) || byLastName.get(lastToken(ap.name)) || null;

    if (!db) {
      updates.push({
        kind: 'new_player',
        player_id: null,
        subject: ap.name,
        old_value: null,
        new_value: '',
        payload: {
          position: ap.position ?? null,
          dateOfBirth: ap.dateOfBirth ?? null,
          nationality: ap.nationality ?? null,
          shirtNumber: ap.shirtNumber ?? null,
        },
      });
      continue;
    }

    matchedDbIds.add(db.id);

    // Shirt number change (only when the source provides one)
    if (ap.shirtNumber != null && db.squad_num != null && ap.shirtNumber !== db.squad_num) {
      updates.push({
        kind: 'squad_num_change',
        player_id: db.id,
        subject: db.name,
        old_value: String(db.squad_num),
        new_value: String(ap.shirtNumber),
        payload: null,
      });
    }
  }

  for (const p of active) {
    if (!matchedDbIds.has(p.id)) {
      updates.push({
        kind: 'possible_departure',
        player_id: p.id,
        subject: p.name,
        old_value: null,
        new_value: '',
        payload: null,
      });
    }
  }

  return updates;
}

/**
 * Full sync run. Returns a summary object; throws on hard failures.
 * @param {{fdToken: string, postgrestUrl: string, adminJwt: string}} cfg
 */
export async function runSquadSync({ fdToken, postgrestUrl, adminJwt }) {
  if (!fdToken) {
    return { skipped: true, reason: 'FOOTBALL_DATA_TOKEN not set' };
  }

  const fdRes = await fetch(FOOTBALL_DATA_URL, { headers: { 'X-Auth-Token': fdToken } });
  if (!fdRes.ok) {
    throw new Error(`football-data.org ${fdRes.status}: ${(await fdRes.text()).slice(0, 200)}`);
  }
  const team = await fdRes.json();
  const apiSquad = team.squad || [];
  if (!apiSquad.length) {
    return { skipped: true, reason: 'football-data returned an empty squad' };
  }

  const adminHeaders = {
    'Authorization': `Bearer ${adminJwt}`,
    'Content-Type': 'application/json',
  };

  const pgRes = await fetch(`${postgrestUrl}/players?select=id,name,squad_num,active`, { headers: adminHeaders });
  if (!pgRes.ok) {
    throw new Error(`PostgREST players ${pgRes.status}: ${(await pgRes.text()).slice(0, 200)}`);
  }
  const dbPlayers = await pgRes.json();

  const updates = diffSquad(apiSquad, dbPlayers);
  if (!updates.length) {
    return { apiPlayers: apiSquad.length, dbActive: dbPlayers.filter(p => p.active).length, found: 0, created: 0 };
  }

  // Insert findings; duplicates (already seen, whatever their status) are ignored
  const insRes = await fetch(
    `${postgrestUrl}/pending_updates?on_conflict=kind,subject,new_value`,
    {
      method: 'POST',
      headers: {
        ...adminHeaders,
        'Prefer': 'return=representation,resolution=ignore-duplicates',
      },
      body: JSON.stringify(updates),
    }
  );
  if (!insRes.ok) {
    throw new Error(`PostgREST pending_updates ${insRes.status}: ${(await insRes.text()).slice(0, 200)}`);
  }
  const created = await insRes.json();

  return {
    apiPlayers: apiSquad.length,
    dbActive: dbPlayers.filter(p => p.active).length,
    found: updates.length,
    created: created.length,
  };
}
