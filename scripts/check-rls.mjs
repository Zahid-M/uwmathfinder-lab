#!/usr/bin/env node
/**
 * check-rls.mjs — prove the public (anon / publishable) key can only INSERT. Run after running
 * supabase/schema.sql, with SUPABASE_URL / SUPABASE_ANON_KEY filled in assets/js/config.js:
 *
 *   node scripts/check-rls.mjs
 *
 * Uses only the public key from config.js (never the secret key). For each of the three tables it
 * inserts a test row (is_test = true, so the export ignores it), then tries to SELECT, UPDATE and
 * DELETE with the same key and expects each to be refused (HTTP 4xx). It also checks that the
 * CHECK constraints reject an email address and that server-only columns (created_at) can't be set.
 * The test rows stay in the table: this key can't delete them, which is the point.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'assets/js/config.js'), 'utf8'), sandbox);
const { SUPABASE_URL: url, SUPABASE_ANON_KEY: key } = sandbox.window.LAB_CONFIG;
if (!url || !key) { console.error('fill SUPABASE_URL and SUPABASE_ANON_KEY in assets/js/config.js first'); process.exit(1); }
const commit = JSON.parse(fs.readFileSync(path.join(root, 'data/source.json'), 'utf8')).commit;

const headers = { apikey: key, 'Content-Type': 'application/json' };
if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;   // legacy JWT anon keys only
const api = async (pathq, init = {}) => {
  const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${pathq}`, { ...init, headers: { ...headers, ...init.headers } });
  return { status: res.status, body: (await res.text()).replace(/\s+/g, ' ').slice(0, 110) };
};
const insert = (table, row) => api(table, { method: 'POST', body: JSON.stringify(row), headers: { Prefer: 'return=minimal' } });

let failed = 0;
const expect = (name, ok, r) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} HTTP ${r.status} ${r.body}`);
  if (!ok) failed++;
};
const refused = r => r.status >= 400 && r.status < 500;

console.log(`project ${url}, key ${key.slice(0, 16)}…\n`);
const session = randomUUID();
const queryId = randomUUID();
const rows = {
  lab_queries: { id: queryId, session_id: session, task: 'search', source: 'human_blind', query: 'rls check (test row)', index_commit: commit, app_version: 'rls-check', is_test: true },
  lab_judgments: { query_id: queryId, session_id: session, question_id: 'q0001', position: 1, rating: 'not_relevant' },
  lab_pairs: { session_id: session, query_ref: 'rls-check', query_source: 'llm', left_id: 'q0001', right_id: 'q0002', left_system: 'assistant', right_system: 'keyword_words', choice: 'neither', index_commit: commit, app_version: 'rls-check', is_test: true },
};
const filter = { lab_queries: `id=eq.${queryId}`, lab_judgments: `query_id=eq.${queryId}`, lab_pairs: `session_id=eq.${session}` };

for (const [table, row] of Object.entries(rows)) {
  console.log(`── ${table}`);
  let r = await insert(table, row);
  expect(`${table}: anon can INSERT`, r.status === 201, r);
  r = await api(`${table}?select=*&limit=5`);
  expect(`${table}: anon cannot SELECT`, refused(r), r);
  r = await api(`${table}?${filter[table]}`, { method: 'PATCH', body: JSON.stringify({ session_id: randomUUID() }), headers: { Prefer: 'return=minimal' } });
  expect(`${table}: anon cannot UPDATE`, refused(r), r);
  r = await api(`${table}?${filter[table]}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  expect(`${table}: anon cannot DELETE`, refused(r), r);
}

console.log('── constraints');
let r = await insert('lab_queries', { ...rows.lab_queries, id: randomUUID(), query: 'mail me at someone@example.com' });
expect('lab_queries: rejects an email address', refused(r), r);
r = await insert('lab_queries', { ...rows.lab_queries, id: randomUUID(), created_at: '2000-01-01T00:00:00Z' });
expect('lab_queries: cannot set created_at', refused(r), r);

console.log(failed ? `\n${failed} check(s) failed: re-run supabase/schema.sql` : '\nall checks passed: the public key can only insert');
process.exit(failed ? 1 : 0);
