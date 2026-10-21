/**
 * submit.mjs — send rows to Supabase. INSERT is the only thing the anon key is allowed to do
 * (supabase/schema.sql), so this file never reads anything back.
 *
 * Plain fetch to Supabase's REST endpoint (PostgREST) instead of the supabase-js client:
 * one POST is all we need (DECISIONS.md, "No supabase-js").
 */

/** Random UUID v4; crypto.randomUUID needs a secure context, so fall back to getRandomValues. */
export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const configured = () => !!(window.LAB_CONFIG.SUPABASE_URL && window.LAB_CONFIG.SUPABASE_ANON_KEY);

/**
 * Insert rows into a table. Resolves on success, rejects with an Error otherwise.
 * Without a configured project it only logs the rows (handy before Supabase is set up).
 */
export async function insert(table, rows) {
  const { SUPABASE_URL: url, SUPABASE_ANON_KEY: key } = window.LAB_CONFIG;
  if (!configured()) {
    console.info(`[lab] Supabase not configured; would insert into ${table}:`, rows);
    return;
  }
  const headers = { apikey: key, 'Content-Type': 'application/json', Prefer: 'return=minimal' };
  // legacy anon keys are JWTs and go in Authorization too; new sb_publishable_ keys don't
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${table}`, { method: 'POST', headers, body: JSON.stringify(rows) });
      if (res.ok) return;
      const body = await res.text();
      // 409 duplicate key: an earlier attempt did save (ids are made here, so a retry is idempotent)
      if (res.status === 409 && /duplicate key/i.test(body)) return;
      // 4xx means the server refused the data (a check failed, the session limit): retrying won't help
      const err = new Error(`${table}: HTTP ${res.status} ${body.slice(0, 200)}`);
      err.permanent = res.status >= 400 && res.status < 500;
      throw err;
    } catch (err) {
      lastErr = err;
      if (err.permanent) break;
    }
  }
  throw lastErr;
}
