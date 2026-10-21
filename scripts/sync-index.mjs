#!/usr/bin/env node
/**
 * sync-index.mjs — copy UWMathFinder's search index and question data into the lab.
 *
 *   node scripts/sync-index.mjs [path/to/UWMathFinder]     (default: ../UWMathFinder)
 *
 * Steps:
 *   1. make sure the checkout is on main with no local changes, then `git pull --ff-only`
 *   2. read MODEL / DTYPE from scripts/assistant-text.mjs and the transformers.js URL from
 *      assets/js/assistant.mjs, and check they agree with the built index
 *   3. copy:
 *        assets/assistant/index.bin, index.json   → assets/assistant/
 *        assets/js/assistant-rank.mjs             → assets/js/vendor/  (byte for byte: same ranking code)
 *        questions.json (only the fields the lab uses) → data/questions.json
 *        chapters.json                            → data/chapters.json
 *        eval/retrieval_queries.json (query text) → data/pair-queries.json  (for "Which is closer?")
 *        every question image (not the answers)   → same relative path (questions/..., questions_207_208/...)
 *   4. write data/source.json with the source commit hash. Every submission stores that hash,
 *      so each judgment is tied to the exact index it was made against.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.resolve(process.argv[2] || path.join(root, '..', 'UWMathFinder'));
const git = (...args) => execFileSync('git', ['-C', src, ...args], { encoding: 'utf8' }).trim();
const readSrc = f => JSON.parse(fs.readFileSync(path.join(src, f), 'utf8'));
const die = msg => { console.error('sync-index: ' + msg); process.exit(1); };

if (!fs.existsSync(path.join(src, 'assets', 'assistant', 'index.bin'))) {
  die(`no UWMathFinder checkout at ${src}. Pass its path: node scripts/sync-index.mjs <path>`);
}

// 1. main, clean, up to date
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') die(`${src} is on branch "${branch}". Run: git -C "${src}" checkout main`);
if (git('status', '--porcelain', '--untracked-files=no')) die(`${src} has uncommitted changes; commit or stash them first`);
console.log(git('pull', '--ff-only', 'origin', 'main'));
const commit = git('rev-parse', 'HEAD');
const commitDate = git('log', '-1', '--format=%cI');

// 2. the model the index was built with, and the browser's transformers.js version
const { MODEL, DTYPE } = await import(pathToFileURL(path.join(src, 'scripts', 'assistant-text.mjs')).href);
const browserJs = fs.readFileSync(path.join(src, 'assets', 'js', 'assistant.mjs'), 'utf8');
const tfUrl = (browserJs.match(/TRANSFORMERS_URL\s*=\s*'([^']+)'/) || [])[1];
const browserModel = (browserJs.match(/const MODEL\s*=\s*'([^']+)'/) || [])[1];
const browserDtype = (browserJs.match(/const DTYPE\s*=\s*'([^']+)'/) || [])[1];
const manifest = readSrc('assets/assistant/index.json');
if (!tfUrl || !/@\d+\.\d+\.\d+$/.test(tfUrl)) die(`could not find a pinned TRANSFORMERS_URL in assets/js/assistant.mjs (got ${tfUrl})`);
if (browserModel !== MODEL || browserDtype !== DTYPE) die(`assistant.mjs uses ${browserModel}/${browserDtype} but assistant-text.mjs says ${MODEL}/${DTYPE}`);
if (manifest.model !== MODEL || manifest.dtype !== DTYPE) die(`index.json was built with ${manifest.model}/${manifest.dtype}, not ${MODEL}/${DTYPE}`);

// 3. copy
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  fs.copyFileSync(path.join(src, from), path.join(root, to));
};
const writeJSON = (to, data) => {
  fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  fs.writeFileSync(path.join(root, to), JSON.stringify(data) + '\n');
};

copy('assets/assistant/index.bin', 'assets/assistant/index.bin');
copy('assets/assistant/index.json', 'assets/assistant/index.json');
copy('assets/js/assistant-rank.mjs', 'assets/js/vendor/assistant-rank.mjs');
copy('chapters.json', 'data/chapters.json');

// only what the lab shows or ranks on (the word-overlap ranker reads chapter, course, skills, source)
const questions = readSrc('questions.json');
if (questions.length !== manifest.ids.length || questions.some((q, i) => q.id !== manifest.ids[i])) {
  die('questions.json and index.json are out of step in UWMathFinder: run `npm run build:index` there first');
}
writeJSON('data/questions.json', questions.map(q => ({
  id: q.id,
  course: q.course,
  chapter: q.chapter,
  ...(q.also_in ? { also_in: q.also_in.map(a => ({ course: a.course })) } : {}),
  image: q.image,
  skills: q.skills || [],
  source: q.source ? {
    exam: q.source.exam, term: q.source.term, exam_id: q.source.exam_id,
    problem: q.source.problem, ...(q.source.staff ? { staff: q.source.staff } : {}),
  } : null,
})));

writeJSON('data/pair-queries.json', readSrc('eval/retrieval_queries.json').map(q => ({
  id: q.id, query: q.query, course: q.course, source: q.source,
})));

// images: copy new or changed files, delete ones no longer referenced
const wanted = new Set(questions.map(q => q.image));
let copied = 0, removed = 0, bytes = 0;
for (const rel of wanted) {
  const from = path.join(src, rel), to = path.join(root, rel);
  const st = fs.statSync(from);
  bytes += st.size;
  const old = fs.existsSync(to) && fs.statSync(to);
  if (old && old.size === st.size && fs.readFileSync(to).equals(fs.readFileSync(from))) continue;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  copied++;
}
for (const dir of new Set([...wanted].map(rel => rel.split('/')[0]))) {
  for (const f of fs.readdirSync(path.join(root, dir))) {
    if (!wanted.has(`${dir}/${f}`)) { fs.unlinkSync(path.join(root, dir, f)); removed++; }
  }
}

// 4. provenance
const source = {
  repo: 'Sigma-Works/UWMathFinder',
  commit,
  commit_date: commitDate,
  model: MODEL,
  dtype: DTYPE,
  transformers_url: tfUrl,
  dims: manifest.dims,
  questions: manifest.count,
  transcribed: manifest.transcribed,
  synced_at: new Date().toISOString(),
};
fs.writeFileSync(path.join(root, 'data', 'source.json'), JSON.stringify(source, null, 1) + '\n');

console.log(`synced UWMathFinder ${commit} (${commitDate})`);
console.log(`model ${MODEL} (${DTYPE}), ${tfUrl}`);
console.log(`${manifest.count} questions, ${manifest.dims} dims; images: ${wanted.size} referenced (${(bytes / 1e6).toFixed(1)} MB), ${copied} copied, ${removed} removed`);
