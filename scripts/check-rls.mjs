#!/usr/bin/env node
/**
 * check-rls.mjs — prove the public anon key can only INSERT. Run after setting up Supabase
 * and filling SUPABASE_URL / SUPABASE_ANON_KEY in assets/js/config.js:
 *
 *   node scripts/check-rls.mjs
 *
 * It inserts one test row (is_test = true, so the export ignores it), then tries to SELECT,
 * UPDATE and DELETE with the same key and expects each to be refused or to touch 0 rows.
 * It also checks that the CHECK constraints reject an email address.
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
if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
const api = (pathq, init = {}) => fetch(`${url.replace(/\/$/, '')}/rest/v1/${pathq}`, { ...init, headers: { ...headers, ...init.headers } });

const id = randomUUID();
const row = { id, session_id: randomUUID(), task: 'search', source: 'human_blind', query: 'rls check (test row)', index_commit: commit, app_version: 'check', is_test: true };
let failed = 0;
const expect = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failed++; };

let r = await api('lab_queries', { method: 'POST', body: JSON.stringify(row), headers: { Prefer: 'return=minimal' } });
expect('insert a row', r.status === 201, `HTTP ${r.status}`);

r = await api('lab_queries', { method: 'POST', body: JSON.stringify({ ...row, id: randomUUID(), query: 'mail me at someone@example.com' }), headers: { Prefer: 'return=minimal' } });
expect('reject an email address', r.status >= 400, `HTTP ${r.status}`);

r = await api(`lab_queries?select=*&limit=5`);
let body = await r.text();
expect('cannot read rows', r.status >= 400 || body.trim() === '[]', `HTTP ${r.status} ${body.slice(0, 80)}`);

r = await api(`lab_queries?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ query: 'changed' }), headers: { Prefer: 'return=representation' } });
body = await r.text();
expect('cannot update rows', r.status >= 400 || body.trim() === '[]', `HTTP ${r.status} ${body.slice(0, 80)}`);

r = await api(`lab_queries?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
body = await r.text();
expect('cannot delete rows', r.status >= 400 || body.trim() === '[]', `HTTP ${r.status} ${body.slice(0, 80)}`);

r = await api('lab_queries', { method: 'POST', body: JSON.stringify({ ...row, id: randomUUID(), created_at: '2000-01-01T00:00:00Z' }), headers: { Prefer: 'return=minimal' } });
expect('cannot set server-only columns (created_at)', r.status >= 400, `HTTP ${r.status}`);

console.log(failed ? `${failed} check(s) failed: re-run supabase/schema.sql` : 'all checks passed: the anon key is insert-only');
process.exit(failed ? 1 : 0);
