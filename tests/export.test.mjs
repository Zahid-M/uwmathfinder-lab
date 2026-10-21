// Fixture rows below are made up for testing the rules; they are not real submissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExport, assignSplits, flagSessions, emptyRegistry } from '../scripts/lib/export-core.mjs';

const C = '9fcce756d80d7219df5595ab2cb04bb8fae9a764';
let n = 0;
const q = (session, query, extra = {}) => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, session_id: session, task: 'search', source: 'human_blind',
  query, course: 'Math 125', scenario_course: 'Math 125', none_relevant: false, index_commit: C, is_test: false,
  created_at: `2026-10-21T00:00:${String(n).padStart(2, '0')}Z`, ...extra,
});
const j = (query, question_id, rating, extra = {}) => ({ query_id: query.id, session_id: query.session_id, question_id, rating, is_check: false, ...extra });

test('flags sessions that rate a check "wanted" or fail most checks; forgives one "related"', () => {
  const { flagged } = flagSessions([
    { session_id: 'a', is_check: true, rating: 'wanted' },
    { session_id: 'b', is_check: true, rating: 'related' },
    { session_id: 'c', is_check: true, rating: 'related' }, { session_id: 'c', is_check: true, rating: 'related' },
    { session_id: 'd', is_check: true, rating: 'not_relevant' }, { session_id: 'd', is_check: true, rating: 'related' },
  ]);
  assert.deepEqual([...flagged.keys()].sort(), ['a', 'c']);
});

test('drops test rows, flagged sessions, duplicates and unrated searches; never outputs session ids', () => {
  const good = q('s1', 'integration by parts');
  const dup = q('s1', 'Integration by parts!');
  const describe = q('s1', 'arc length', { task: 'describe', source: 'human_image_shown', target_id: 'q0100', scenario_course: 'Math 125', none_relevant: null });
  const bad = q('s2', 'anything');
  const testRow = q('s3', 'my own test', { is_test: true });
  const unrated = q('s4', 'never rated');
  const raw = {
    queries: [good, dup, describe, bad, testRow, unrated],
    judgments: [
      j(good, 'q0001', 'wanted'), j(good, 'q0002', 'related'), j(good, 'q0003', 'not_relevant'), j(good, 'q0900', 'not_relevant', { is_check: true }),
      j(dup, 'q0001', 'wanted'),
      j(bad, 'q0001', 'wanted'), j(bad, 'q0901', 'wanted', { is_check: true }),
      j(testRow, 'q0001', 'wanted'),
    ],
    pairs: [
      { session_id: 's1', query_ref: 'r001', query_source: 'llm', course: 'Math 125', left_id: 'q1', right_id: 'q2', left_system: 'assistant', right_system: 'keyword_words', choice: 'right', index_commit: C, is_test: false },
      { session_id: 's2', query_ref: 'r002', query_source: 'llm', course: 'Math 125', left_id: 'q1', right_id: 'q2', left_system: 'assistant', right_system: 'keyword_words', choice: 'left', index_commit: C, is_test: false },
    ],
  };
  const { queries, pairs, report } = buildExport(raw, emptyRegistry('t'));
  assert.equal(report.test_rows_dropped.queries, 1);
  assert.equal(report.sessions_flagged, 1);
  assert.equal(report.duplicates_dropped, 1);
  assert.equal(report.search_queries_without_ratings, 1);
  assert.deepEqual(queries.map(x => x.query).sort(), ['arc length', 'integration by parts']);
  const s = queries.find(x => x.source === 'human_blind');
  assert.deepEqual(s.judgments, { q0001: 2, q0002: 1, q0003: 0 });   // the check q0900 is not a judgment
  assert.ok(['test', 'dev'].includes(s.split));
  const d = queries.find(x => x.source === 'human_image_shown');
  assert.deepEqual(d.judgments, { q0100: 2 });
  assert.equal(d.split, null);
  assert.deepEqual(pairs.map(p => p.preferred), ['keyword_words']);
  assert.ok(!JSON.stringify({ queries, pairs }).includes('session'));
});

test('split: 70/30 within each course, deterministic, and old assignments never move', () => {
  const items = [];
  for (const course of ['Math 124', 'Math 125', 'none']) for (let i = 0; i < 100; i++) items.push({ id: `${course}-${i}`, stratum: course });
  const r1 = assignSplits(items, emptyRegistry('seed-1'));
  for (const course of ['Math 124', 'Math 125', 'none']) {
    const test = Object.values(r1.assignments).filter(a => a.stratum === course && a.split === 'test').length;
    assert.equal(test, 70, course);
  }
  assert.deepEqual(assignSplits(items, emptyRegistry('seed-1')), r1);
  assert.notDeepEqual(assignSplits(items, emptyRegistry('seed-2')).assignments, r1.assignments);

  // more data later: earlier items keep their split, shares stay near 70%
  const more = [...items];
  for (let i = 100; i < 137; i++) more.push({ id: `Math 125-${i}`, stratum: 'Math 125' });
  const r2 = assignSplits(more, r1);
  for (const [id, a] of Object.entries(r1.assignments)) assert.deepEqual(r2.assignments[id], a);
  const m125 = Object.values(r2.assignments).filter(a => a.stratum === 'Math 125');
  assert.equal(m125.filter(a => a.split === 'test').length, Math.round(0.7 * 137));
});
