#!/usr/bin/env node
/**
 * export.mjs — pull submissions from Supabase and write eval files for UWMathFinder.
 *
 *   node scripts/export.mjs                  download, then build the export
 *   node scripts/export.mjs --from out/raw.json   rebuild from a saved download (no network)
 *   options: --out <file> (default out/eval-export.json), --splits <file> (default splits/splits.json)
 *
 * Needs a local, untracked .env (see .env.example) with:
 *   SUPABASE_URL=https://<project>.supabase.co
 *   SUPABASE_SERVICE_KEY=<service_role / secret key>   ← can read everything: never commit it,
 *                                                         never put it in the browser
 *   SPLIT_SEED=uwmf-lab-v1                             (optional; fixed once the first export runs)
 *
 * Writes:
 *   out/raw.json            the downloaded rows, as-is (gitignored: contains session ids)
 *   out/eval-export.json    queries with graded judgments, source and split; no session ids
 *   splits/splits.json      the frozen TEST/DEV registry (committed: query ids only)
 *
 * Rules (flags, dedupe, grades, splits) live in lib/export-core.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildExport, emptyRegistry } from './lib/export-core.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = f => path.join(root, f);
const args = process.argv.slice(2);
const die = m => { console.error('export: ' + m); process.exit(1); };

function loadEnv() {
  const env = { ...process.env };
  if (fs.existsSync(at('.env'))) {
    for (const line of fs.readFileSync(at('.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

/** Every row of a table, 1000 at a time, oldest first. The service key bypasses RLS. */
async function fetchAll(url, key, table) {
  const headers = { apikey: key };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;   // legacy JWT keys
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${table}?select=*&order=created_at.asc,id.asc`,
      { headers: { ...headers, Range: `${from}-${from + 999}`, 'Range-Unit': 'items' } });
    if (!res.ok) die(`${table}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

const env = loadEnv();
let raw;
const fromIdx = args.indexOf('--from');
if (fromIdx >= 0) {
  raw = JSON.parse(fs.readFileSync(path.resolve(args[fromIdx + 1]), 'utf8'));
} else {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) die('set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env (see .env.example)');
  raw = {
    downloaded_at: new Date().toISOString(),
    queries: await fetchAll(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, 'lab_queries'),
    judgments: await fetchAll(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, 'lab_judgments'),
    pairs: await fetchAll(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, 'lab_pairs'),
  };
  fs.mkdirSync(at('out'), { recursive: true });
  fs.writeFileSync(at('out/raw.json'), JSON.stringify(raw, null, 1) + '\n');
}
console.log(`rows: ${raw.queries.length} queries, ${raw.judgments.length} judgments, ${raw.pairs.length} pairs`);

// the split registry is frozen: same seed forever, existing assignments never change
const seed = env.SPLIT_SEED || 'uwmf-lab-v1';
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? path.resolve(args[i + 1]) : at(dflt); };
const regFile = opt('--splits', 'splits/splits.json');
const outFile = opt('--out', 'out/eval-export.json');
const registry = fs.existsSync(regFile) ? JSON.parse(fs.readFileSync(regFile, 'utf8')) : emptyRegistry(seed);
if (registry.seed !== seed) die(`SPLIT_SEED "${seed}" differs from splits/splits.json seed "${registry.seed}". The split is frozen; don't change the seed.`);

const result = buildExport(raw, registry);

let labCommit = null;
try { labCommit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
const out = {
  exported_at: new Date().toISOString(),
  lab_commit: labCommit,
  split_seed: registry.seed,
  grades: { wanted: 2, related: 1, not_relevant: 0 },
  report: result.report,
  queries: result.queries,
  pairs: result.pairs,
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n');
fs.mkdirSync(path.dirname(regFile), { recursive: true });
fs.writeFileSync(regFile, JSON.stringify(result.registry, null, 1) + '\n');

console.log(JSON.stringify(result.report, null, 1));
console.log(`wrote ${path.relative(root, outFile)} (${result.queries.length} queries, ${result.pairs.length} pairs) and ${path.relative(root, regFile)}`);
console.log('next: in UWMathFinder (on the human-eval branch) run  node scripts/import-lab.mjs');
