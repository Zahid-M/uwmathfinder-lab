#!/usr/bin/env node
/**
 * check-secrets.mjs — fail if any committed (or staged) file contains a Supabase secret key prefix.
 *
 *   node scripts/check-secrets.mjs              HEAD and the staging area
 *   node scripts/check-secrets.mjs --history    ...and every commit ever made
 *
 * Secret keys start with the prefix below; publishable keys (sb_publishable_…) are public and fine.
 * The prefix is built from two parts so this file doesn't match itself. Runs in CI on every push
 * (.github/workflows/checks.yml). If it ever fails: rotate the key in Supabase first (Project
 * Settings → API Keys), then remove it from the repo.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEEDLE = 'sb_' + 'secret_';

/** git grep for the fixed string; returns matching "rev:path" lines (exit 1 = no match). */
function grep(opts, revs = []) {
  try {
    return execFileSync('git', ['-C', root, 'grep', '-l', ...opts, '-F', NEEDLE, ...revs], { encoding: 'utf8', maxBuffer: 64 << 20 })
      .split('\n').filter(Boolean);
  } catch (err) {
    if (err.status === 1) return [];
    throw err;
  }
}

const revs = process.argv.includes('--history')
  ? execFileSync('git', ['-C', root, 'rev-list', '--all'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  : ['HEAD'];
const hits = [...new Set([...grep(['--cached']), ...grep([], revs)])];
const files = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean).length;

if (hits.length) {
  console.error(`FAIL: "${NEEDLE}" found in:\n  ${hits.join('\n  ')}`);
  console.error('Rotate that key in Supabase (Project Settings → API Keys), then remove it from the repo.');
  process.exit(1);
}
console.log(`ok: "${NEEDLE}" not found in ${files} tracked files (staged and ${revs.length === 1 ? 'HEAD' : `${revs.length} commits`})`);
