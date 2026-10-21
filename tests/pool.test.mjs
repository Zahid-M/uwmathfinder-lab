import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPool, pickCheck, keywordWordsRanking, chapterNames, mulberry32, shuffle, POOL_SIZE } from '../assets/js/pool.mjs';

const questions = JSON.parse(fs.readFileSync(new URL('../data/questions.json', import.meta.url)));
const names = chapterNames(JSON.parse(fs.readFileSync(new URL('../data/chapters.json', import.meta.url))));
const ids = n => Array.from({ length: n }, (_, i) => `q${String(i + 1).padStart(4, '0')}`);

test('pool has 5 distinct ids, exactly one random pick, and records both ranks', () => {
  const all = ids(100);
  for (let seed = 1; seed <= 200; seed++) {
    const rng = mulberry32(seed);
    const pool = buildPool({ assistant: all, words: shuffle(all, rng).slice(0, 30), courseIds: all, rng });
    assert.equal(pool.length, POOL_SIZE);
    assert.equal(new Set(pool.map(p => p.id)).size, POOL_SIZE);
    assert.equal(pool.filter(p => p.is_random).length, 1);
    assert.equal(pool.filter(p => p.is_check).length, 0);
    for (const p of pool.filter(p => !p.is_random)) assert.ok(p.assistant_rank !== null || p.words_rank !== null);
  }
});

test('the random pick avoids the top 10 of both rankings', () => {
  const all = ids(100);
  for (let seed = 1; seed <= 200; seed++) {
    const rng = mulberry32(seed);
    const words = all.slice().reverse();
    const r = buildPool({ assistant: all, words, courseIds: all, rng }).find(p => p.is_random);
    assert.ok(r.assistant_rank > 10 && r.words_rank > 10, `seed ${seed}: ${JSON.stringify(r)}`);
  }
});

test('both systems contribute when their tops differ', () => {
  const all = ids(100);
  const pool = buildPool({ assistant: all, words: all.slice().reverse(), courseIds: all, rng: mulberry32(7) });
  const fromA = pool.filter(p => !p.is_random && p.assistant_rank <= 2).length;
  const fromW = pool.filter(p => !p.is_random && p.words_rank <= 2).length;
  assert.equal(fromA, 2);
  assert.equal(fromW, 2);
});

test('with an attention check: still 5, one check, check id included', () => {
  const all = ids(50);
  const pool = buildPool({ assistant: all, words: [], courseIds: all, checkId: 'q9999', rng: mulberry32(3) });
  assert.equal(pool.length, POOL_SIZE);
  assert.deepEqual(pool.filter(p => p.is_check).map(p => p.id), ['q9999']);
});

test('no word overlap: pool fills from the assistant', () => {
  const all = ids(20);
  const pool = buildPool({ assistant: all, words: [], courseIds: all, rng: mulberry32(1) });
  assert.equal(pool.length, POOL_SIZE);
  assert.ok(pool.every(p => p.words_rank === null));
});

test('tiny course: pool stops when every candidate is used', () => {
  const all = ids(3);
  const pool = buildPool({ assistant: all, words: all, courseIds: all, rng: mulberry32(1) });
  assert.equal(pool.length, 3);
});

test('keyword ranking matches metadata words and respects the course filter', () => {
  const r = keywordWordsRanking(questions, names, 'taylor series', 'Math 126');
  assert.ok(r.length > 0);
  const byId = new Map(questions.map(q => [q.id, q]));
  assert.ok(r.every(id => byId.get(id).course === 'Math 126' || (byId.get(id).also_in || []).some(a => a.course === 'Math 126')));
  assert.match(byId.get(r[0]).chapter, /taylor/);
  assert.deepEqual(keywordWordsRanking(questions, names, 'zz qq', null), []);
});

test('attention check comes from a different course and has the lowest score in its sample', () => {
  const score = new Map(questions.map((q, i) => [q.id, (i % 97) / 97]));
  for (let seed = 1; seed <= 50; seed++) {
    const id = pickCheck(questions, 'Math 125', score, mulberry32(seed));
    const q = questions.find(x => x.id === id);
    assert.notEqual(q.course, 'Math 125');
    assert.ok(!(q.also_in || []).some(a => a.course === 'Math 125'));
  }
});
